"""Behave steps for Cognito id_token to user Principal resolution."""

from __future__ import annotations

from datetime import UTC, datetime

from behave import given, then, when
from cognito_test_support import make_cognito_test_keys, mint_id_token

from chatticus.cognito_jwt import CognitoTokenError
from chatticus.control_plane import ControlPlane
from chatticus.http.paths import org_path
from chatticus.http.principal import (
    _MEMBERSHIP_CACHE,
    resolve_user_principal_from_token,
)
from chatticus.models import IdentityNotFoundError, OrganizationStatus
from chatticus.principal import PrincipalKind

NOW = datetime(2026, 8, 31, 12, 0, 0, tzinfo=UTC)


def _keys(context: object) -> object:
    keys = getattr(context, "cognito_test_keys", None)
    if keys is None:
        keys = make_cognito_test_keys()
        context.cognito_test_keys = keys
    return keys


@given('tenant "{tenant_id}" has an enabled organization for "{email}"')
def given_enabled_org(context: object, tenant_id: str, email: str) -> None:
    _MEMBERSHIP_CACHE.clear()
    context.resolver_tenant_id = tenant_id
    plane = ControlPlane()
    plane.admin_seed_organization(tenant_id, email, name="Test Org", now=NOW)
    context.plane = plane


@given('tenant "{tenant_id}" has a suspended organization for "{email}"')
def given_suspended_org(context: object, tenant_id: str, email: str) -> None:
    _MEMBERSHIP_CACHE.clear()
    context.resolver_tenant_id = tenant_id
    plane = ControlPlane()
    plane.admin_seed_organization(tenant_id, email, name="Test Org", now=NOW)
    plane.suspend_organization(tenant_id)
    context.plane = plane


@when('the Cognito resolver receives a valid id token for "{email}"')
def when_valid_id_token(context: object, email: str) -> None:
    keys = _keys(context)
    token = mint_id_token(keys, email=email)
    context.resolver_error = None
    try:
        context.resolved_principal = resolve_user_principal_from_token(
            context.plane,
            context.resolver_tenant_id,
            token,
            verifier=keys.verifier(),
        )
    except Exception as error:
        context.resolved_principal = None
        context.resolver_error = error


@when('the Cognito resolver receives an expired id token for "{email}"')
def when_expired_id_token(context: object, email: str) -> None:
    keys = _keys(context)
    token = mint_id_token(
        keys,
        email=email,
        expires_at=datetime(2020, 1, 1, tzinfo=UTC),
    )
    context.resolver_error = None
    try:
        context.resolved_principal = resolve_user_principal_from_token(
            context.plane,
            context.resolver_tenant_id,
            token,
            verifier=keys.verifier(),
        )
    except Exception as error:
        context.resolved_principal = None
        context.resolver_error = error


@then('the resolved principal has kind "{kind}"')
def then_resolved_kind(context: object, kind: str) -> None:
    assert context.resolved_principal is not None
    assert context.resolved_principal.kind == PrincipalKind(kind)


@then('the resolved principal belongs to tenant "{tenant_id}"')
def then_resolved_tenant(context: object, tenant_id: str) -> None:
    assert context.resolved_principal is not None
    assert context.resolved_principal.tenant_id == tenant_id


@then('the resolved principal has organization status "{status}"')
def then_resolved_org_status(context: object, status: str) -> None:
    assert context.resolved_principal is not None
    assert context.resolved_principal.organization_status == OrganizationStatus(status)


@then('the resolved principal has role "{role}"')
def then_resolved_role(context: object, role: str) -> None:
    assert context.resolved_principal is not None
    assert context.resolved_principal.role.value == role


@then("Cognito token resolution fails")
def then_cognito_resolution_fails(context: object) -> None:
    assert isinstance(context.resolver_error, CognitoTokenError)


@then("identity resolution fails for unknown email")
def then_identity_resolution_fails(context: object) -> None:
    assert isinstance(context.resolver_error, IdentityNotFoundError)


@when("a browser route is called without Authorization")
def when_browser_route_without_auth(context: object) -> None:
    response = context.api_client.post(
        org_path("anthus", "/bots"),
        json={"user_id": "ryan", "name": "Helper"},
    )
    context.browser_route_status = response.status_code


@then("the browser route succeeds without a principal")
def then_browser_route_succeeds(context: object) -> None:
    assert context.browser_route_status == 200
