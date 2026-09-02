"""Shared Cognito browser auth helpers for behave HTTP steps."""

from __future__ import annotations

from typing import Any

from cognito_test_support import make_cognito_test_keys, mint_id_token
from http_test_support import (
    DEFAULT_OWNER_EMAIL,
    AuthedUserClient,
    _preferred_user_id_from_path,
    _request_path,
    _should_inject_user_auth,
    _tenant_id_from_path,
    ensure_test_org,
)

from chatticus.http.app import create_app
from chatticus.http.test_server import start_test_server


def cognito_test_keys(context: object) -> object:
    """Return scenario-local Cognito test keys, creating them when needed."""
    keys = getattr(context, "cognito_test_keys", None)
    if keys is None:
        keys = make_cognito_test_keys()
        context.cognito_test_keys = keys
    return keys


def ensure_org_membership(
    context: object,
    tenant_id: str,
    *,
    owner_email: str = DEFAULT_OWNER_EMAIL,
    preferred_user_id: str | None = None,
) -> str:
    """Seed one enabled organization for *tenant_id* when not already present."""
    email = ensure_test_org(
        context.plane,
        tenant_id,
        owner_email=owner_email,
        preferred_user_id=preferred_user_id,
    )
    seeded = getattr(context, "seeded_org_emails", None)
    if seeded is None:
        context.seeded_org_emails = {}
        seeded = context.seeded_org_emails
    seeded[tenant_id] = email
    return email


def browser_user_auth_headers(
    context: object,
    tenant_id: str,
    *,
    preferred_user_id: str | None = None,
) -> dict[str, str]:
    """Return Authorization headers for one enabled org member."""
    email = ensure_org_membership(
        context,
        tenant_id,
        preferred_user_id=preferred_user_id,
    )
    token = mint_id_token(cognito_test_keys(context), email=email)
    return {"Authorization": f"Bearer {token}"}


class AuthedBrowserClient(AuthedUserClient):
    """Behave-facing wrapper around the pytest authed HTTP client."""

    def __init__(self, client: Any, context: object) -> None:
        super().__init__(client, context.plane)
        self._context = context

    def request(self, method: str, url: str, **kwargs: Any) -> Any:
        headers = dict(kwargs.pop("headers", {}) or {})
        if _should_inject_user_auth(self._plane, method, url, headers):
            tenant_id = _tenant_id_from_path(_request_path(url))
            if tenant_id is not None:
                preferred_user_id = _preferred_user_id_from_path(_request_path(url))
                headers.update(
                    browser_user_auth_headers(
                        self._context,
                        tenant_id,
                        preferred_user_id=preferred_user_id,
                    )
                )
        return self._client.request(method, url, headers=headers, **kwargs)

    def stream(self, method: str, url: str, **kwargs: Any) -> Any:
        headers = dict(kwargs.pop("headers", {}) or {})
        if _should_inject_user_auth(self._plane, method, url, headers):
            tenant_id = _tenant_id_from_path(_request_path(url))
            if tenant_id is not None:
                preferred_user_id = _preferred_user_id_from_path(_request_path(url))
                headers.update(
                    browser_user_auth_headers(
                        self._context,
                        tenant_id,
                        preferred_user_id=preferred_user_id,
                    )
                )
        return self._client.stream(method, url, headers=headers, **kwargs)


def wrap_browser_client(client: Any, context: object) -> AuthedBrowserClient:
    """Wrap one httpx client so org user routes receive Cognito auth by default."""
    wrapped = AuthedBrowserClient(client, context)
    context.raw_api_client = client
    return wrapped


def wire_test_http_front_door(context: object, plane: Any, **kwargs: Any) -> None:
    """Attach a Cognito-verified FastAPI app and authed HTTP client to *context*."""
    client = getattr(context, "api_client", None)
    if client is not None:
        client.close()
    keys = cognito_test_keys(context)
    context.api_app = create_app(
        plane,
        cognito_verifier=keys.verifier(),
        **kwargs,
    )
    context.app_state = context.api_app.state.chatticus
    context.api_client = wrap_browser_client(
        start_test_server(context.api_app),
        context,
    )
