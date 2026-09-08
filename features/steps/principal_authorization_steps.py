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
    response = getattr(context, "principal_response", None) or getattr(
        context, "self_setup_response", None
    )
    assert response is not None
    assert response.status_code == status, response.text


@given(
    'the in-memory role inspector trusts tenant "{tenant_id}" ExternalId '
    "with full permissions"
)
def given_inspector_trusts_tenant(context: object, tenant_id: str) -> None:
    from cross_account_provisioning_steps import (
        CUSTOMER_ACCOUNT_ID,
        CUSTOMER_ROLE_ARN,
        PROVISIONING_REQUIRED_PERMISSIONS,
    )

    from chatticus.cross_account_provisioning import (
        CrossAccountRoleSnapshot,
        InMemoryCrossAccountRoleInspector,
    )
    from chatticus.http.app import create_app

    snapshot = CrossAccountRoleSnapshot(
        account_id=CUSTOMER_ACCOUNT_ID,
        role_arn=CUSTOMER_ROLE_ARN,
        trusted_external_id=tenant_id,
        granted_permissions=frozenset(PROVISIONING_REQUIRED_PERMISSIONS),
    )
    role_inspector = InMemoryCrossAccountRoleInspector(
        {(CUSTOMER_ACCOUNT_ID, CUSTOMER_ROLE_ARN): snapshot}
    )
    context.role_inspector = role_inspector
    context.aws_account_id = CUSTOMER_ACCOUNT_ID
    context.aws_role_arn = CUSTOMER_ROLE_ARN
    keys = cognito_test_keys(context)
    client = getattr(context, "api_client", None)
    if client is not None:
        client.close()
    context.api_app = create_app(
        context.plane,
        invoke_key="",
        cognito_verifier=keys.verifier(),
        role_inspector=role_inspector,
    )
    from browser_auth_helpers import wrap_browser_client

    from chatticus.http.test_server import start_test_server

    context.api_client = wrap_browser_client(
        start_test_server(context.api_app),
        context,
    )


@when('the owner submits cross-account self-setup for tenant "{tenant_id}" via HTTP')
def when_owner_submits_self_setup_for_tenant(context: object, tenant_id: str) -> None:
    email = context.seeded_org_emails[tenant_id]
    token = mint_id_token(cognito_test_keys(context), email=email)
    context.self_setup_response = context.raw_api_client.post(
        org_path(tenant_id, "/self-setup/cross-account-role"),
        headers={"Authorization": f"Bearer {token}"},
        json={
            "account_id": context.aws_account_id,
            "cross_account_role": context.aws_role_arn,
        },
    )
    context.principal_response = context.self_setup_response
