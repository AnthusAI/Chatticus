"""Behave steps for customer cross-account self-setup provisioning."""

from __future__ import annotations

from datetime import UTC, datetime

from behave import given, then, when

from chatticus.control_plane import ControlPlane
from chatticus.cross_account_provisioning import (
    PROVISIONING_REQUIRED_PERMISSIONS,
    CrossAccountRoleSnapshot,
    InMemoryCrossAccountRoleInspector,
)
from chatticus.messaging.store import InMemoryMessagingStore
from chatticus.models import AwsSetupPath, OrganizationStatus

CUSTOMER_ACCOUNT_ID = "123456789012"
CUSTOMER_ROLE_ARN = (
    f"arn:aws:iam::{CUSTOMER_ACCOUNT_ID}:role/ChatticusOrganizationComputerRole"
)
MISMATCHED_EXTERNAL_ID = "wrong-organization-id"
MISSING_PERMISSION = PROVISIONING_REQUIRED_PERMISSIONS[0]
NOW = datetime(2026, 8, 31, 12, 0, 0, tzinfo=UTC)


def _plane(context: object) -> ControlPlane:
    return context.plane


def _ensure_org_store(context: object) -> None:
    if not getattr(context, "plane", None):
        context.plane = ControlPlane(messaging_store=InMemoryMessagingStore())
    context.orgs_by_name = getattr(context, "orgs_by_name", {}) or {}
    context.identities_by_email = getattr(context, "identities_by_email", {}) or {}
    context.now = getattr(context, "now", NOW)
    _plane(context).set_now(context.now)


def _create_pending_customer_org(context: object) -> None:
    _ensure_org_store(context)
    identity = _plane(context).sign_in("owner@example.com", now=context.now)
    context.customer_org = _plane(context).create_organization(
        identity,
        "Acme",
        now=context.now,
    )
    context.aws_account_id = CUSTOMER_ACCOUNT_ID
    context.aws_role_arn = CUSTOMER_ROLE_ARN


def _set_role_inspector(
    context: object,
    *,
    trusted_external_id: str,
    granted_permissions: frozenset[str],
) -> None:
    snapshot = CrossAccountRoleSnapshot(
        account_id=context.aws_account_id,
        role_arn=context.aws_role_arn,
        trusted_external_id=trusted_external_id,
        granted_permissions=granted_permissions,
    )
    context.role_inspector = InMemoryCrossAccountRoleInspector(
        {(context.aws_account_id, context.aws_role_arn): snapshot}
    )


@given("a customer who has run the cross-account template in their own account")
def given_customer_ran_template(context: object) -> None:
    _create_pending_customer_org(context)
    _set_role_inspector(
        context,
        trusted_external_id=context.customer_org.tenant_id,
        granted_permissions=frozenset(PROVISIONING_REQUIRED_PERMISSIONS),
    )


@given("a customer whose role trusts a different ExternalId")
def given_role_trusts_different_external_id(context: object) -> None:
    _create_pending_customer_org(context)
    _set_role_inspector(
        context,
        trusted_external_id=MISMATCHED_EXTERNAL_ID,
        granted_permissions=frozenset(PROVISIONING_REQUIRED_PERMISSIONS),
    )


@given("a customer whose role lacks a permission provisioning needs")
def given_role_lacks_permission(context: object) -> None:
    _create_pending_customer_org(context)
    granted_permissions = frozenset(
        permission
        for permission in PROVISIONING_REQUIRED_PERMISSIONS
        if permission != MISSING_PERMISSION
    )
    _set_role_inspector(
        context,
        trusted_external_id=context.customer_org.tenant_id,
        granted_permissions=granted_permissions,
    )


@when("they submit their AWS account id and role")
def when_submit_account_and_role(context: object) -> None:
    context.self_setup_result = _plane(context).submit_self_setup_cross_account_role(
        context.customer_org.tenant_id,
        account_id=context.aws_account_id,
        cross_account_role=context.aws_role_arn,
        role_inspector=context.role_inspector,
    )


@then("provisioning proceeds without an assisted session")
def then_provisioning_without_assisted_session(context: object) -> None:
    result = context.self_setup_result
    assert result.accepted is True, result.message
    organization = result.organization
    assert organization.status == OrganizationStatus.ENABLED
    assert organization.aws_setup_path == AwsSetupPath.CUSTOMER_OWNED
    assert organization.assisted_setup_session is False


@then("no setup fee is charged")
def then_no_setup_fee_charged(context: object) -> None:
    organization = context.self_setup_result.organization
    assert organization.setup_fee_cents == 0


@then("the response names the ExternalId mismatch and how to correct it")
def then_response_names_external_id_mismatch(context: object) -> None:
    result = context.self_setup_result
    assert result.accepted is False
    message = result.message or ""
    lowered = message.lower()
    assert "externalid" in lowered.replace(" ", ""), message
    assert MISMATCHED_EXTERNAL_ID in message, message
    assert context.customer_org.tenant_id in message, message
    assert "cloudformation" in lowered, message
    assert "organizationid" in lowered.replace(" ", ""), message


@then("the response names the missing permission")
def then_response_names_missing_permission(context: object) -> None:
    result = context.self_setup_result
    assert result.accepted is False
    message = result.message or ""
    assert MISSING_PERMISSION in message, message


@then("the organization stays pending")
def then_organization_stays_pending(context: object) -> None:
    organization = context.self_setup_result.organization
    assert organization.status == OrganizationStatus.PENDING
    assert organization.aws_account_id is None
    assert organization.aws_cross_account_role is None
