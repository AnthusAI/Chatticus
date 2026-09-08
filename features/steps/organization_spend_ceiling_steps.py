"""Behave steps for organization monthly AWS spend ceiling."""

from __future__ import annotations

from decimal import Decimal

from behave import given, then, when
from cross_account_provisioning_steps import (
    CUSTOMER_ACCOUNT_ID,
    CUSTOMER_ROLE_ARN,
    NOW,
    _ensure_org_store,
    _plane,
)

from chatticus.cross_account_provisioning import (
    PROVISIONING_REQUIRED_PERMISSIONS,
    CrossAccountRoleSnapshot,
    InMemoryCrossAccountRoleInspector,
)
from chatticus.models import (
    NotOrganizationOwnerError,
    OrganizationStatus,
)

DEFAULT_CEILING_USD = Decimal("250.00")
HIGHER_CEILING_USD = Decimal("500.00")


def _organization(context: object) -> object:
    organization = getattr(context, "spend_ceiling_org", None)
    if organization is None:
        raise AssertionError("No organization is set for spend ceiling scenarios.")
    return organization


def _reload_organization(context: object) -> object:
    organization = _organization(context)
    stored = _plane(context).get_organization(organization.tenant_id)
    assert stored is not None, organization.tenant_id
    context.spend_ceiling_org = stored
    return stored


def _provision_enabled_org_with_ceiling(context: object) -> None:
    _ensure_org_store(context)
    owner = _plane(context).sign_in("owner@example.com", now=context.now)
    organization = _plane(context).create_organization(
        owner,
        "Acme Labs",
        now=context.now,
    )
    context.spend_ceiling_owner = owner
    context.spend_ceiling_org = organization
    context.monthly_aws_spend_ceiling_usd = DEFAULT_CEILING_USD
    snapshot = CrossAccountRoleSnapshot(
        account_id=CUSTOMER_ACCOUNT_ID,
        role_arn=CUSTOMER_ROLE_ARN,
        trusted_external_id=organization.tenant_id,
        granted_permissions=frozenset(PROVISIONING_REQUIRED_PERMISSIONS),
    )
    role_inspector = InMemoryCrossAccountRoleInspector(
        {(CUSTOMER_ACCOUNT_ID, CUSTOMER_ROLE_ARN): snapshot}
    )
    result = _plane(context).submit_self_setup_cross_account_role(
        organization.tenant_id,
        actor_user_id=owner.user_id,
        account_id=CUSTOMER_ACCOUNT_ID,
        cross_account_role=CUSTOMER_ROLE_ARN,
        role_inspector=role_inspector,
        monthly_aws_spend_ceiling_usd=DEFAULT_CEILING_USD,
    )
    assert result.accepted is True, result.message
    context.spend_ceiling_org = result.organization


@given("an organization being provisioned into a customer AWS account")
def given_org_being_provisioned(context: object) -> None:
    _ensure_org_store(context)
    owner = _plane(context).sign_in("owner@example.com", now=context.now)
    organization = _plane(context).create_organization(
        owner,
        "Acme Labs",
        now=context.now,
    )
    context.spend_ceiling_owner = owner
    context.spend_ceiling_org = organization
    context.monthly_aws_spend_ceiling_usd = DEFAULT_CEILING_USD
    snapshot = CrossAccountRoleSnapshot(
        account_id=CUSTOMER_ACCOUNT_ID,
        role_arn=CUSTOMER_ROLE_ARN,
        trusted_external_id=organization.tenant_id,
        granted_permissions=frozenset(PROVISIONING_REQUIRED_PERMISSIONS),
    )
    context.role_inspector = InMemoryCrossAccountRoleInspector(
        {(CUSTOMER_ACCOUNT_ID, CUSTOMER_ROLE_ARN): snapshot}
    )


@when("provisioning completes")
def when_provisioning_completes(context: object) -> None:
    organization = _organization(context)
    owner = context.spend_ceiling_owner
    result = _plane(context).submit_self_setup_cross_account_role(
        organization.tenant_id,
        actor_user_id=owner.user_id,
        account_id=CUSTOMER_ACCOUNT_ID,
        cross_account_role=CUSTOMER_ROLE_ARN,
        role_inspector=context.role_inspector,
        monthly_aws_spend_ceiling_usd=context.monthly_aws_spend_ceiling_usd,
    )
    assert result.accepted is True, result.message
    context.spend_ceiling_org = result.organization


@then("the organization carries a monthly AWS spend ceiling")
def then_org_carries_ceiling(context: object) -> None:
    organization = _reload_organization(context)
    assert organization.monthly_aws_spend_ceiling_usd == DEFAULT_CEILING_USD
    assert organization.status == OrganizationStatus.ENABLED
    assert organization.aws_account_id == CUSTOMER_ACCOUNT_ID
    assert organization.aws_cross_account_role == CUSTOMER_ROLE_ARN


@given("an enabled organization with a monthly spend ceiling")
def given_enabled_org_with_ceiling(context: object) -> None:
    context.now = getattr(context, "now", NOW)
    _provision_enabled_org_with_ceiling(context)


@when("its owner sets a higher ceiling")
def when_owner_sets_higher_ceiling(context: object) -> None:
    organization = _organization(context)
    owner = context.spend_ceiling_owner
    updated = _plane(context).set_monthly_aws_spend_ceiling(
        organization.tenant_id,
        owner.user_id,
        HIGHER_CEILING_USD,
    )
    context.spend_ceiling_org = updated


@then("the organization carries the new ceiling")
def then_org_carries_new_ceiling(context: object) -> None:
    organization = _reload_organization(context)
    assert organization.monthly_aws_spend_ceiling_usd == HIGHER_CEILING_USD


@when("a member who is not an owner attempts to change it")
def when_member_attempts_change_ceiling(context: object) -> None:
    organization = _organization(context)
    owner = context.spend_ceiling_owner
    member = _plane(context).sign_in("member@example.com", now=context.now)
    invitation = _plane(context).invite_by_email(
        organization.tenant_id,
        owner.user_id,
        "member@example.com",
        now=context.now,
    )
    _plane(context).accept_invitation(
        invitation.invitation_id,
        member,
        now=context.now,
    )
    context.last_error = None
    try:
        _plane(context).set_monthly_aws_spend_ceiling(
            organization.tenant_id,
            member.user_id,
            HIGHER_CEILING_USD,
        )
    except NotOrganizationOwnerError as error:
        context.last_error = error


@then("the change is refused")
def then_change_refused(context: object) -> None:
    assert isinstance(context.last_error, NotOrganizationOwnerError), context.last_error


@then("the ceiling is unchanged")
def then_ceiling_unchanged(context: object) -> None:
    organization = _reload_organization(context)
    assert organization.monthly_aws_spend_ceiling_usd == DEFAULT_CEILING_USD
