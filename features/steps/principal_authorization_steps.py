"""Behave steps for principal enforcement on the HTTP front door."""

from __future__ import annotations

from behave import given, then, when
from browser_auth_helpers import (
    browser_user_auth_headers,
    cognito_test_keys,
    wire_test_http_front_door,
)
from cognito_test_support import mint_id_token
from http_test_support import NOW

from chatticus.control_plane import ControlPlane
from chatticus.http.paths import org_path


@given('principal enforcement has tenant "{tenant_id}" enabled for "{email}"')
def given_enabled_tenant_for_principal(
    context: object, tenant_id: str, email: str
) -> None:
    context.plane = ControlPlane()
    context.plane.admin_seed_organization(
        tenant_id,
        email,
        name="Test Org",
        now=NOW,
    )
    context.seeded_org_emails = {tenant_id: email}
    wire_test_http_front_door(context, context.plane, invoke_key="")


@given('principal enforcement has tenant "{tenant_id}" pending for "{email}"')
def given_pending_tenant_for_principal(
    context: object, tenant_id: str, email: str
) -> None:
    context.plane = ControlPlane()
    owner = context.plane.sign_in(email, now=NOW)
    context.plane._org_records._put_pending_organization(
        owner,
        tenant_id,
        tenant_id=tenant_id,
        now=NOW,
    )
    context.seeded_org_emails = {tenant_id: email}
    wire_test_http_front_door(context, context.plane, invoke_key="")


@when("an org user route is called without Authorization")
def when_org_user_route_without_auth(context: object) -> None:
    context.principal_response = context.raw_api_client.post(
        org_path("anthus", "/bots"),
        json={"user_id": "ryan", "name": "Helper"},
    )


@when('an org user route is called for tenant "{tenant_id}" with Authorization')
def when_org_user_route_with_auth(context: object, tenant_id: str) -> None:
    context.principal_response = context.api_client.post(
        org_path(tenant_id, "/bots"),
        json={"user_id": "ryan", "name": "Helper"},
        headers=browser_user_auth_headers(context, tenant_id),
    )


@when('an org user route is called for tenant "{tenant_id}" with a token for "{email}"')
def when_org_user_route_with_email_token(
    context: object, tenant_id: str, email: str
) -> None:
    token = mint_id_token(cognito_test_keys(context), email=email)
    context.principal_response = context.raw_api_client.post(
        org_path(tenant_id, "/bots"),
        json={"user_id": "ryan", "name": "Helper"},
        headers={"Authorization": f"Bearer {token}"},
    )


@when("GET /health is called")
def when_get_health_for_principal(context: object) -> None:
    context.principal_response = context.raw_api_client.get("/health")


@when("GET /auth/callback is called")
def when_get_auth_callback(context: object) -> None:
    context.principal_response = context.raw_api_client.get("/auth/callback")


@then("the principal response status is {status:d}")
def then_principal_response_status(context: object, status: int) -> None:
    assert (
        context.principal_response.status_code == status
    ), context.principal_response.text
