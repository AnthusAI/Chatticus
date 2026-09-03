"""Development-only IAM-role session exchange and integration bearer tokens."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Final

import httpx
from fastapi import HTTPException, Request

from chatticus.integration_test.sigv4 import STS_GET_CALLER_IDENTITY_URL

INTEGRATION_TEST_SESSION_PATH: Final = "/integration-test/session"
DEFAULT_INTEGRATION_TEST_TENANT_ID: Final = "integration-test"
DEFAULT_INTEGRATION_TEST_USER_ID: Final = "integration-test-runner"
DEFAULT_INTEGRATION_TEST_OWNER_EMAIL: Final = "integration-test@chattic.us"
DEFAULT_TOKEN_TTL_SECONDS: Final = 900
_BEHAVE_ROLE_HEADER: Final = "X-Chatticus-Integration-Test-Role"
_STS_FORWARD_HEADERS: Final = frozenset(
    {
        "authorization",
        "x-amz-date",
        "x-amz-security-token",
        "host",
    }
)


@dataclass(frozen=True)
class IntegrationTestAuthConfig:
    """Runtime configuration for integration-test session exchange."""

    enabled: bool
    environment: str
    allowed_role_arn: str
    tenant_id: str
    user_id: str
    hmac_secret: bytes
    token_ttl_seconds: int = DEFAULT_TOKEN_TTL_SECONDS
    caller_verifier: Callable[[Request], str | None] | None = None
    now: Callable[[], datetime] | None = None


def integration_test_enabled_from_env() -> bool:
    """Return whether integration-test auth is enabled in this process."""
    return os.environ.get("CHATTICUS_INTEGRATION_TEST_ENABLED", "").strip() == "1"


def integration_test_hmac_secret(invoke_key: str) -> bytes:
    """Derive the integration bearer signing secret from the invoke key."""
    return hmac.new(
        b"chatticus-integration-test-v1",
        invoke_key.encode(),
        hashlib.sha256,
    ).digest()


def _ssm_parameter_value(name: str) -> str:
    try:
        import boto3
    except ImportError:
        return ""
    region = (
        os.environ.get("AWS_REGION")
        or os.environ.get("AWS_DEFAULT_REGION")
        or "us-east-1"
    )
    ssm = boto3.client("ssm", region_name=region)
    try:
        response = ssm.get_parameter(Name=name)
    except Exception:
        return ""
    return response["Parameter"]["Value"].strip()


def load_integration_test_auth_config(
    *,
    environment: str,
    invoke_key: str,
    allowed_role_arn: str | None = None,
    tenant_id: str | None = None,
    user_id: str | None = None,
    enabled: bool | None = None,
    caller_verifier: Callable[[Request], str | None] | None = None,
) -> IntegrationTestAuthConfig | None:
    """Build config when integration-test auth is active for *environment*."""
    resolved_enabled = (
        enabled if enabled is not None else integration_test_enabled_from_env()
    )
    if not resolved_enabled or environment == "production":
        return None
    prefix = f"/chatticus/{environment}/integration-test"
    resolved_role = (
        allowed_role_arn
        or os.environ.get("CHATTICUS_INTEGRATION_TEST_ALLOWED_ROLE_ARN", "")
        or _ssm_parameter_value(f"{prefix}/allowed-role-arn")
    ).strip()
    resolved_tenant = (
        tenant_id
        or os.environ.get("CHATTICUS_INTEGRATION_TEST_TENANT_ID", "")
        or _ssm_parameter_value(f"{prefix}/tenant-id")
    ).strip() or DEFAULT_INTEGRATION_TEST_TENANT_ID
    resolved_user = (
        user_id
        or os.environ.get("CHATTICUS_INTEGRATION_TEST_USER_ID", "")
        or _ssm_parameter_value(f"{prefix}/user-id")
    ).strip() or DEFAULT_INTEGRATION_TEST_USER_ID
    if not resolved_role:
        return None
    return IntegrationTestAuthConfig(
        enabled=True,
        environment=environment,
        allowed_role_arn=resolved_role,
        tenant_id=resolved_tenant,
        user_id=resolved_user,
        hmac_secret=integration_test_hmac_secret(invoke_key),
        caller_verifier=caller_verifier,
    )


def behave_caller_verifier(request: Request) -> str | None:
    """Return a declared caller role ARN for in-process behave scenarios."""
    role = request.headers.get(_BEHAVE_ROLE_HEADER, "").strip()
    return role or None


def relay_sts_get_caller_identity_arn(request: Request) -> str | None:
    """Verify SigV4 STS credentials by relaying GetCallerIdentity."""
    forwarded = {
        key: value
        for key, value in request.headers.items()
        if key.lower() in _STS_FORWARD_HEADERS
    }
    if "authorization" not in {key.lower() for key in forwarded}:
        return None
    if "host" not in {key.lower() for key in forwarded}:
        forwarded["Host"] = "sts.amazonaws.com"
    try:
        response = httpx.get(
            STS_GET_CALLER_IDENTITY_URL,
            params={"Action": "GetCallerIdentity", "Version": "2011-06-15"},
            headers=forwarded,
            timeout=10.0,
        )
    except httpx.HTTPError:
        return None
    if response.status_code != 200:
        return None
    try:
        import xml.etree.ElementTree as ET

        root = ET.fromstring(response.text)
    except ET.ParseError:
        return None
    namespace = {"aws": "https://sts.amazonaws.com/doc/2011-06-15/"}
    arn_node = root.find(".//aws:Arn", namespace)
    if arn_node is None or not arn_node.text:
        return None
    return arn_node.text.strip()


def verify_session_caller(request: Request, config: IntegrationTestAuthConfig) -> str:
    """Return the verified caller role ARN or raise HTTPException."""
    verifier = config.caller_verifier or relay_sts_get_caller_identity_arn
    role_arn = verifier(request)
    if role_arn is None:
        raise HTTPException(status_code=403, detail="integration test caller required")
    if role_arn != config.allowed_role_arn:
        raise HTTPException(
            status_code=403, detail="integration test caller not allowed"
        )
    return role_arn


def _now(config: IntegrationTestAuthConfig) -> datetime:
    if config.now is not None:
        return config.now()
    return datetime.now(tz=UTC)


def mint_integration_test_token(config: IntegrationTestAuthConfig) -> str:
    """Mint one short-lived integration bearer token."""
    issued_at = _now(config)
    expires_at = issued_at + timedelta(seconds=config.token_ttl_seconds)
    payload = {
        "kind": "integration_test",
        "tenant_id": config.tenant_id,
        "user_id": config.user_id,
        "iat": int(issued_at.timestamp()),
        "exp": int(expires_at.timestamp()),
    }
    payload_segment = (
        base64.urlsafe_b64encode(
            json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
        )
        .decode()
        .rstrip("=")
    )
    signature = hmac.new(
        config.hmac_secret,
        payload_segment.encode(),
        hashlib.sha256,
    ).hexdigest()
    return f"{payload_segment}.{signature}"


def mint_integration_test_token_expired(config: IntegrationTestAuthConfig) -> str:
    """Mint an already-expired integration bearer token for negative tests."""
    issued_at = _now(config) - timedelta(hours=2)
    expires_at = issued_at + timedelta(minutes=5)
    payload = {
        "kind": "integration_test",
        "tenant_id": config.tenant_id,
        "user_id": config.user_id,
        "iat": int(issued_at.timestamp()),
        "exp": int(expires_at.timestamp()),
    }
    payload_segment = (
        base64.urlsafe_b64encode(
            json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
        )
        .decode()
        .rstrip("=")
    )
    signature = hmac.new(
        config.hmac_secret,
        payload_segment.encode(),
        hashlib.sha256,
    ).hexdigest()
    return f"{payload_segment}.{signature}"


def parse_integration_test_token(token: str) -> tuple[str, str] | None:
    """Split one integration bearer token into payload and signature segments."""
    if "." not in token:
        return None
    payload_segment, signature = token.rsplit(".", 1)
    return payload_segment, signature


def verify_integration_test_token(
    token: str,
    *,
    config: IntegrationTestAuthConfig,
) -> dict[str, Any] | None:
    """Return token payload when *token* is a valid integration bearer."""
    parsed = parse_integration_test_token(token)
    if parsed is None:
        return None
    payload_segment, signature = parsed
    expected = hmac.new(
        config.hmac_secret,
        payload_segment.encode(),
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(expected, signature):
        return None
    padding = "=" * (-len(payload_segment) % 4)
    try:
        payload = json.loads(base64.urlsafe_b64decode(payload_segment + padding))
    except (json.JSONDecodeError, ValueError):
        return None
    if payload.get("kind") != "integration_test":
        return None
    if payload.get("tenant_id") != config.tenant_id:
        return None
    if payload.get("user_id") != config.user_id:
        return None
    exp = payload.get("exp")
    if not isinstance(exp, int):
        return None
    if exp <= int(_now(config).timestamp()):
        return None
    return payload


def integration_test_session_enabled(config: IntegrationTestAuthConfig | None) -> bool:
    """Return whether the session exchange route should be mounted."""
    return config is not None and config.enabled and config.environment != "production"


def create_integration_test_session_response(
    request: Request,
    config: IntegrationTestAuthConfig,
) -> dict[str, str]:
    """Exchange one verified IAM caller for an integration bearer token."""
    verify_session_caller(request, config)
    token = mint_integration_test_token(config)
    return {"token": token, "token_type": "Bearer"}


def resolve_integration_test_principal(
    plane: Any,
    tenant_id: str,
    token: str,
    *,
    config: IntegrationTestAuthConfig,
) -> Any:
    """Map one integration bearer token to a user principal for *tenant_id*."""
    from chatticus.principal import Principal, PrincipalKind

    payload = verify_integration_test_token(token, config=config)
    if payload is None:
        raise HTTPException(
            status_code=403, detail="invalid integration test credential"
        )
    if tenant_id != config.tenant_id:
        raise HTTPException(
            status_code=403,
            detail="integration test credential tenant mismatch",
        )
    membership = plane.get_membership(tenant_id, config.user_id)
    if membership is None:
        raise HTTPException(
            status_code=403,
            detail=(
                f"User {config.user_id!r} is not a member of "
                f"organization {tenant_id!r}."
            ),
        )
    organization = plane.get_organization(tenant_id)
    return Principal(
        kind=PrincipalKind.USER,
        tenant_id=tenant_id,
        user_id=config.user_id,
        organization_status=organization.status,
        role=membership.role,
    )


def assert_integration_test_user_id(
    request: Request,
    actor_user_id: str,
    *,
    principal_user_id: str | None,
) -> None:
    """Reject integration bearer calls that name a different user id in the body."""
    if not getattr(request.state, "integration_test_auth", False):
        return
    if principal_user_id is None or actor_user_id != principal_user_id:
        raise HTTPException(
            status_code=403,
            detail="integration test credential user mismatch",
        )


def seed_integration_test_organization(
    plane: Any,
    *,
    tenant_id: str = DEFAULT_INTEGRATION_TEST_TENANT_ID,
    user_id: str = DEFAULT_INTEGRATION_TEST_USER_ID,
    owner_email: str = DEFAULT_INTEGRATION_TEST_OWNER_EMAIL,
    now: datetime | None = None,
) -> None:
    """Seed one enabled organization for the dedicated integration-test user."""
    from chatticus.models import Identity

    resolved_now = now or datetime.now(tz=UTC)
    normalized = owner_email.strip().lower()
    existing = plane.get_identity_by_email(normalized)
    if existing is None:
        plane._messaging_store.put_identity(
            Identity(user_id=user_id, email=normalized, created_at=resolved_now)
        )
    plane.admin_seed_organization(
        tenant_id,
        owner_email,
        name="Integration Test",
        now=resolved_now,
    )
