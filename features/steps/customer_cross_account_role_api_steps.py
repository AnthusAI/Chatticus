"""Behave steps for customer self-setup cross-account role HTTP API."""

from __future__ import annotations

from behave import given, then, when
from cognito_test_support import mint_id_token
from cross_account_provisioning_steps import (
    CUSTOMER_ACCOUNT_ID,
    CUSTOMER_ROLE_ARN,
    MISMATCHED_EXTERNAL_ID,
    MISSING_PERMISSION,
    PROVISIONING_REQUIRED_PERMISSIONS,
    _ensure_org_store,
    _plane,
)
from me_steps import _keys
from operator_organization_api_steps import DEFAULT_OPERATOR_KEY

from chatticus.control_plane import ControlPlane
from chatticus.cross_account_provisioning import (
    CrossAccountRoleSnapshot,
    InMemoryCrossAccountRoleInspector,
)
from chatticus.http.app import create_app
from chatticus.http.paths import org_self_setup_cross_account_role_path
from chatticus.http.test_server import start_test_server
from chatticus.models import MemberRole, Membership, OrganizationStatus
from chatticus.signup_mode import SignupMode


def _close_client(context: object) -> None:
    client = getattr(context, "api_client", None)
    if client is not None:
        client.close()


def _wire_self_setup_front_door(context: object) -> None:
    _keys(context)
    if not getattr(context, "plane", None):
        context.plane = ControlPlane()
    context.orgs_by_name = getattr(context, "orgs_by_name", {}) or {}
    context.identities_by_email = getattr(context, "identities_by_email", {}) or {}
    context.now = getattr(context, "now", context.plane.now())
    _plane(context).set_now(context.now)
    role_inspector = getattr(context, "role_inspector", None)
    if role_inspector is None:
        raise AssertionError("role_inspector is not configured for this scenario.")
    _close_client(context)
    context.api_app = create_app(
        context.plane,
        invoke_key="",
        cognito_verifier=_keys(context).verifier(),
        signup_mode=SignupMode.OPEN,
        role_inspector=role_inspector,
        operator_key=getattr(context, "configured_operator_key", DEFAULT_OPERATOR_KEY),
    )
    context.app_state = context.api_app.state.chatticus
    from browser_auth_helpers import wrap_browser_client

    context.api_client = wrap_browser_client(
        start_test_server(context.api_app),
        context,
    )
    context.web_api_base = str(context.api_client.base_url)


def _customer_org(context: object) -> object:
    organization = getattr(context, "customer_self_setup_org", None)
    if organization is None:
        raise AssertionError("No pending self-setup organization is set.")
    return organization


def _self_setup_path(context: object, tenant_id: str | None = None) -> str:
    organization = _customer_org(context) if tenant_id is None else None
    resolved_tenant_id = tenant_id or organization.tenant_id
    return org_self_setup_cross_account_role_path(resolved_tenant_id)


def _submit_payload(context: object) -> dict[str, str]:
    return {
        "account_id": getattr(context, "aws_account_id", CUSTOMER_ACCOUNT_ID),
        "cross_account_role": getattr(context, "aws_role_arn", CUSTOMER_ROLE_ARN),
        "monthly_aws_spend_ceiling_usd": getattr(
            context,
            "monthly_aws_spend_ceiling_usd",
            "250.00",
        ),
    }


@given(
    "the customer self-setup HTTP front door is wired with an in-memory role inspector"
)
def given_self_setup_front_door(context: object) -> None:
    _ensure_org_store(context)
    context.configured_operator_key = DEFAULT_OPERATOR_KEY
    context.role_inspector = InMemoryCrossAccountRoleInspector(snapshots={})
    _wire_self_setup_front_door(context)


@given('a pending organization owned by "{email}"')
def given_pending_organization_owned_by(context: object, email: str) -> None:
    _ensure_org_store(context)
    owner = _plane(context).sign_in(email, now=context.now)
    organization = _plane(context).create_organization(
        owner,
        "Acme Labs" if email == "owner@example.com" else "Other Labs",
        now=context.now,
    )
    context.identities_by_email[email] = owner
    if getattr(context, "customer_self_setup_org", None) is None:
        context.customer_self_setup_org = organization
        context.customer_org = organization
        context.aws_account_id = CUSTOMER_ACCOUNT_ID
        context.aws_role_arn = CUSTOMER_ROLE_ARN
        context.orgs_by_name = {organization.name: organization}
        context.self_setup_owner_email = email
    else:
        context.other_self_setup_org = organization


def _configure_role_inspector_for_tenant(
    context: object,
    tenant_id: str,
    *,
    trusted_external_id: str,
    granted_permissions: frozenset[str] | None = None,
) -> None:
    permissions = granted_permissions or frozenset(PROVISIONING_REQUIRED_PERMISSIONS)
    snapshot = CrossAccountRoleSnapshot(
        account_id=CUSTOMER_ACCOUNT_ID,
        role_arn=CUSTOMER_ROLE_ARN,
        trusted_external_id=trusted_external_id,
        granted_permissions=permissions,
    )
    context.role_inspector = InMemoryCrossAccountRoleInspector(
        {(CUSTOMER_ACCOUNT_ID, CUSTOMER_ROLE_ARN): snapshot}
    )
    app_state = getattr(context, "app_state", None)
    if app_state is not None:
        app_state.role_inspector = context.role_inspector


@given(
    "the in-memory role inspector trusts the organization ExternalId "
    "with full permissions"
)
def given_inspector_trusts_org_external_id(context: object) -> None:
    organization = _customer_org(context)
    _configure_role_inspector_for_tenant(
        context,
        organization.tenant_id,
        trusted_external_id=organization.tenant_id,
    )
    _wire_self_setup_front_door(context)


@given(
    "the in-memory role inspector trusts a mismatched ExternalId with full permissions"
)
def given_inspector_mismatched_external_id(context: object) -> None:
    organization = _customer_org(context)
    _configure_role_inspector_for_tenant(
        context,
        organization.tenant_id,
        trusted_external_id=MISMATCHED_EXTERNAL_ID,
    )
    _wire_self_setup_front_door(context)


@given(
    "the in-memory role inspector trusts the organization ExternalId "
    "without full permissions"
)
def given_inspector_missing_permission(context: object) -> None:
    organization = _customer_org(context)
    granted_permissions = frozenset(
        permission
        for permission in PROVISIONING_REQUIRED_PERMISSIONS
        if permission != MISSING_PERMISSION
    )
    _configure_role_inspector_for_tenant(
        context,
        organization.tenant_id,
        trusted_external_id=organization.tenant_id,
        granted_permissions=granted_permissions,
    )
    _wire_self_setup_front_door(context)


@given('"{email}" is a non-owner member of that organization')
def given_non_owner_member(context: object, email: str) -> None:
    organization = _customer_org(context)
    member = _plane(context).sign_in(email, now=context.now)
    _plane(context)._messaging_store.put_membership(
        Membership(
            tenant_id=organization.tenant_id,
            user_id=member.user_id,
            role=MemberRole.MEMBER,
            joined_at=context.now,
        )
    )
    context.identities_by_email[email] = member


@when("the owner submits their AWS account id and RoleArn via HTTP")
def when_owner_submits_via_http(context: object) -> None:
    email = context.self_setup_owner_email
    token = mint_id_token(_keys(context), email=email)
    context.self_setup_response = context.raw_api_client.post(
        _self_setup_path(context),
        headers={"Authorization": f"Bearer {token}"},
        json=_submit_payload(context),
    )


@when('"{email}" submits the AWS account id and RoleArn via HTTP')
def when_email_submits_via_http(context: object, email: str) -> None:
    token = mint_id_token(_keys(context), email=email)
    context.self_setup_response = context.raw_api_client.post(
        _self_setup_path(context),
        headers={"Authorization": f"Bearer {token}"},
        json=_submit_payload(context),
    )


@when(
    '"{email}" submits the AWS account id and RoleArn for the other '
    "organization via HTTP"
)
def when_email_submits_for_other_org(context: object, email: str) -> None:
    other = context.other_self_setup_org
    token = mint_id_token(_keys(context), email=email)
    context.self_setup_response = context.raw_api_client.post(
        org_self_setup_cross_account_role_path(other.tenant_id),
        headers={"Authorization": f"Bearer {token}"},
        json=_submit_payload(context),
    )


@when("the self-setup endpoint is called without Authorization")
def when_self_setup_without_auth(context: object) -> None:
    context.self_setup_response = context.raw_api_client.post(
        _self_setup_path(context),
        json=_submit_payload(context),
    )


@when("the operator submits the AWS account id and RoleArn via HTTP")
def when_operator_submits_via_http(context: object) -> None:
    organization = _customer_org(context)
    token = getattr(context, "operator_bearer_token", DEFAULT_OPERATOR_KEY)
    context.self_setup_response = context.raw_api_client.post(
        org_self_setup_cross_account_role_path(organization.tenant_id),
        headers={"Authorization": f"Bearer {token}"},
        json=_submit_payload(context),
    )


@when("the operator calls the enable endpoint for that pending organization")
def when_operator_enables_pending_org(context: object) -> None:
    context.operator_organization = _customer_org(context)
    context.operator_bearer_token = getattr(
        context, "configured_operator_key", DEFAULT_OPERATOR_KEY
    )
    context.operator_response = context.raw_api_client.post(
        f"/operator/orgs/{context.operator_organization.tenant_id}/enable",
        headers={"Authorization": f"Bearer {context.operator_bearer_token}"},
    )


@then("the self-setup response status is {status:d}")
def then_self_setup_status(context: object, status: int) -> None:
    response = context.self_setup_response
    assert response.status_code == status, response.text


@then("the self-setup response accepts the submission")
def then_self_setup_accepts(context: object) -> None:
    payload = context.self_setup_response.json()
    assert payload["accepted"] is True


@then("that organization is enabled with AWS home recorded")
def then_org_enabled_with_aws_home(context: object) -> None:
    organization = _customer_org(context)
    updated = _plane(context).get_organization(organization.tenant_id)
    assert updated.status == OrganizationStatus.ENABLED
    assert updated.aws_account_id == CUSTOMER_ACCOUNT_ID
    assert updated.aws_cross_account_role == CUSTOMER_ROLE_ARN
    assert updated.aws_external_id == organization.tenant_id


@then("that organization stays pending with no AWS home")
def then_org_pending_no_aws_home(context: object) -> None:
    organization = _customer_org(context)
    updated = _plane(context).get_organization(organization.tenant_id)
    assert updated.status == OrganizationStatus.PENDING
    assert updated.aws_account_id is None
    assert updated.aws_cross_account_role is None


@then("the self-setup response names the ExternalId mismatch and how to correct it")
def then_http_external_id_mismatch(context: object) -> None:
    detail = context.self_setup_response.json()["detail"]
    lowered = detail.lower()
    assert "externalid" in lowered.replace(" ", ""), detail
    assert MISMATCHED_EXTERNAL_ID in detail, detail
    organization = _customer_org(context)
    assert organization.tenant_id in detail, detail
    assert "cloudformation" in lowered, detail
    assert "organizationid" in lowered.replace(" ", ""), detail


@then("the self-setup response names the missing permission")
def then_http_missing_permission(context: object) -> None:
    detail = context.self_setup_response.json()["detail"]
    assert MISSING_PERMISSION in detail, detail


@then("the self-setup response detail mentions self-setup requires pending")
def then_http_requires_pending(context: object) -> None:
    detail = context.self_setup_response.json()["detail"]
    assert "self-setup requires pending" in detail, detail


@then("that pending organization is enabled with no AWS home")
def then_pending_enabled_no_aws_home(context: object) -> None:
    organization = _customer_org(context)
    updated = _plane(context).get_organization(organization.tenant_id)
    assert updated.status == OrganizationStatus.ENABLED
    assert updated.aws_account_id is None
    assert updated.aws_cross_account_role is None
