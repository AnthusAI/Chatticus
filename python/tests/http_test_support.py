"""Shared HTTP test client helpers for pytest."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlparse

from cognito_test_support import make_cognito_test_keys, mint_id_token

from chatticus.control_plane import ControlPlane
from chatticus.http.app import create_app
from chatticus.http.principal import is_worker_bootstrap_route, is_worker_route_path
from chatticus.http.test_server import start_test_server
from chatticus.models import (
    Identity,
    MemberRole,
    Membership,
    Organization,
    OrganizationNotFoundError,
    OrganizationSeedConflictError,
    OrganizationStatus,
)
from chatticus.org_records import normalize_email

NOW = datetime(2026, 8, 31, 12, 0, 0, tzinfo=UTC)
DEFAULT_OWNER_EMAIL = "owner@chatticus.test"
_TEST_KEYS = make_cognito_test_keys()
_ORG_PATH_RE = re.compile(r"^/orgs/(?P<tenant_id>[^/]+)")
_USER_PATH_RE = re.compile(r"/users/(?P<user_id>[^/]+)")


def cognito_verifier() -> object:
    """Return the shared offline Cognito verifier for HTTP tests."""
    return _TEST_KEYS.verifier()


def _preferred_user_id_from_path(path: str) -> str | None:
    match = _USER_PATH_RE.search(path)
    if match is None:
        return None
    return match.group("user_id")


def _seed_org_for_user(
    plane: ControlPlane,
    tenant_id: str,
    user_id: str,
    *,
    owner_email: str,
) -> str:
    normalized = normalize_email(owner_email)
    identity = plane._org_records.store.get_identity_by_email(normalized)
    if identity is None or identity.user_id != user_id:
        normalized = normalize_email(f"{user_id}@{tenant_id}.test")
        identity = plane._org_records.store.get_identity_by_email(normalized)
        if identity is None:
            identity = Identity(user_id=user_id, email=normalized, created_at=NOW)
            plane._org_records.store.put_identity(identity)
    organization = Organization(
        tenant_id=tenant_id,
        name=tenant_id,
        status=OrganizationStatus.ENABLED,
        owner_user_id=identity.user_id,
        created_at=NOW,
    )
    plane._org_records.store.put_organization(organization)
    plane._org_records.store.put_membership(
        Membership(
            tenant_id=tenant_id,
            user_id=identity.user_id,
            role=MemberRole.OWNER,
            joined_at=NOW,
        )
    )
    return identity.email


def ensure_test_org(
    plane: ControlPlane,
    tenant_id: str = "anthus",
    *,
    owner_email: str = DEFAULT_OWNER_EMAIL,
    preferred_user_id: str | None = None,
) -> str:
    """Seed one enabled organization when missing."""
    try:
        org = plane.get_organization(tenant_id)
        user_id = preferred_user_id or org.owner_user_id
        identity = plane._org_records.store.get_identity(user_id)
        if identity is not None:
            return identity.email
        return owner_email
    except OrganizationNotFoundError:
        pass
    try:
        plane.admin_seed_organization(
            tenant_id,
            owner_email,
            name=tenant_id,
            now=NOW,
        )
        return owner_email
    except OrganizationSeedConflictError:
        user_id = preferred_user_id or "ryan"
        return _seed_org_for_user(
            plane,
            tenant_id,
            user_id,
            owner_email=owner_email,
        )


def user_auth_headers(
    plane: ControlPlane,
    tenant_id: str = "anthus",
    *,
    owner_email: str = DEFAULT_OWNER_EMAIL,
    preferred_user_id: str | None = None,
) -> dict[str, str]:
    """Return Authorization headers for one enabled org member."""
    email = ensure_test_org(
        plane,
        tenant_id,
        owner_email=owner_email,
        preferred_user_id=preferred_user_id,
    )
    token = mint_id_token(_TEST_KEYS, email=email)
    return {"Authorization": f"Bearer {token}"}


def _request_path(url: str) -> str:
    if url.startswith("/"):
        return url
    return urlparse(str(url)).path


def _tenant_id_from_path(path: str) -> str | None:
    match = _ORG_PATH_RE.match(path)
    if match is None:
        return None
    return match.group("tenant_id")


def _should_inject_user_auth(
    plane: ControlPlane,
    method: str,
    url: str,
    headers: dict[str, str] | None,
) -> bool:
    if headers and headers.get("Authorization"):
        return False
    path = _request_path(url)
    tenant_id = _tenant_id_from_path(path)
    if tenant_id is None:
        return False
    if is_worker_bootstrap_route(path, method=method):
        return False
    if is_worker_route_path(path):
        return False
    preferred_user_id = _preferred_user_id_from_path(path)
    ensure_test_org(plane, tenant_id, preferred_user_id=preferred_user_id)
    return True


class AuthedUserClient:
    """httpx client wrapper that injects Cognito auth on org user routes."""

    def __init__(self, client: Any, plane: ControlPlane) -> None:
        self._client = client
        self._plane = plane
        self.headers = client.headers

    def request(self, method: str, url: str, **kwargs: Any) -> Any:
        headers = dict(kwargs.pop("headers", {}) or {})
        if _should_inject_user_auth(self._plane, method, url, headers):
            tenant_id = _tenant_id_from_path(_request_path(url))
            if tenant_id is not None:
                preferred_user_id = _preferred_user_id_from_path(_request_path(url))
                headers.update(
                    user_auth_headers(
                        self._plane,
                        tenant_id,
                        preferred_user_id=preferred_user_id,
                    )
                )
        return self._client.request(method, url, headers=headers, **kwargs)

    def get(self, url: str, **kwargs: Any) -> Any:
        return self.request("GET", url, **kwargs)

    def post(self, url: str, **kwargs: Any) -> Any:
        return self.request("POST", url, **kwargs)

    def put(self, url: str, **kwargs: Any) -> Any:
        return self.request("PUT", url, **kwargs)

    def delete(self, url: str, **kwargs: Any) -> Any:
        return self.request("DELETE", url, **kwargs)

    def patch(self, url: str, **kwargs: Any) -> Any:
        return self.request("PATCH", url, **kwargs)

    def stream(self, method: str, url: str, **kwargs: Any) -> Any:
        headers = dict(kwargs.pop("headers", {}) or {})
        if _should_inject_user_auth(self._plane, method, url, headers):
            tenant_id = _tenant_id_from_path(_request_path(url))
            if tenant_id is not None:
                preferred_user_id = _preferred_user_id_from_path(_request_path(url))
                headers.update(
                    user_auth_headers(
                        self._plane,
                        tenant_id,
                        preferred_user_id=preferred_user_id,
                    )
                )
        return self._client.stream(method, url, headers=headers, **kwargs)

    def close(self) -> None:
        self._client.close()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._client, name)


def start_authed_test_server(plane: ControlPlane, **kwargs: Any) -> AuthedUserClient:
    """Start one Cognito-verified HTTP server and return an authed client."""
    ensure_test_org(plane)
    app = create_app(
        plane,
        cognito_verifier=cognito_verifier(),
        **kwargs,
    )
    return AuthedUserClient(start_test_server(app), plane)
