"""Behave steps for authorized connections between organizations."""

from __future__ import annotations

from datetime import UTC, datetime

from behave import given, then, when
from behave.exception import StepNotImplementedError
from browser_auth_helpers import ensure_org_membership, wire_test_http_front_door

NOW = datetime(2026, 8, 31, 12, 0, 0, tzinfo=UTC)


def _org(context: object, name: str) -> object:
    org = getattr(context, "orgs_by_name", {}).get(name)
    if org is None:
        raise AssertionError(f"Unknown organization {name!r}.")
    return org


def _pending_behavior(step_name: str) -> None:
    raise StepNotImplementedError(
        f"Authorized connection behavior is not implemented yet: {step_name}"
    )


@given('organization "{name}" with tenant "{tenant_id}" also has enabled members:')
def given_additional_organization_with_enabled_members(
    context: object, name: str, tenant_id: str
) -> None:
    emails = [row.cells[0].strip() for row in context.table]
    if not emails:
        raise AssertionError("Member table is empty.")
    owner_email = emails[0]
    plane = context.plane
    org = plane.admin_seed_organization(
        tenant_id,
        owner_email,
        name=name,
        now=NOW,
    )
    owner = plane.sign_in(owner_email, now=NOW)
    orgs_by_name = getattr(context, "orgs_by_name", None)
    if orgs_by_name is None:
        orgs_by_name = {}
        context.orgs_by_name = orgs_by_name
    orgs_by_name[name] = org
    identities_by_email = getattr(context, "identities_by_email", None)
    if identities_by_email is None:
        identities_by_email = {}
        context.identities_by_email = identities_by_email
    identities_by_email[owner_email] = owner
    context.shared_channels_by_name = getattr(context, "shared_channels_by_name", {})
    context.bots_by_name = getattr(context, "bots_by_name", {})
    ensure_org_membership(context, tenant_id, owner_email=owner_email)
    wire_test_http_front_door(context, plane, invoke_key="")
    for email in emails[1:]:
        invitation = plane.invite_by_email(
            tenant_id,
            owner.user_id,
            email,
            now=NOW,
        )
        member = plane.sign_in(email, now=NOW)
        plane.accept_invitation(invitation.invitation_id, member, now=NOW)
        identities_by_email[email] = member


@when(
    '"{email}" proposes a connection for organization "{receiving_org}" to read '
    'shared channel "{channel_name}" in organization "{granting_org}"'
)
def when_member_proposes_connection(
    context: object,
    email: str,
    receiving_org: str,
    channel_name: str,
    granting_org: str,
) -> None:
    _org(context, receiving_org)
    _org(context, granting_org)
    context.authorized_connection_proposer = email
    context.authorized_connection_receiving_org = receiving_org
    context.authorized_connection_channel = channel_name
    context.authorized_connection_granting_org = granting_org
    _pending_behavior("member proposes connection within authority ceiling")


@when(
    '"{email}" tries to propose a connection for organization "{receiving_org}" '
    'to read shared channel "{channel_name}" in organization "{granting_org}"'
)
def when_member_tries_propose_connection(
    context: object,
    email: str,
    receiving_org: str,
    channel_name: str,
    granting_org: str,
) -> None:
    _org(context, receiving_org)
    _org(context, granting_org)
    context.authorized_connection_proposer = email
    context.authorized_connection_receiving_org = receiving_org
    context.authorized_connection_channel = channel_name
    context.authorized_connection_granting_org = granting_org
    _pending_behavior("member refused connection outside authority ceiling")


@when("the connection proposal is routed for approval")
def when_connection_proposal_routed_for_approval(context: object) -> None:
    _pending_behavior("route connection proposal for approval")


@then('the connection is authorized and clipped to "{email}" ceiling')
def then_connection_authorized_and_clipped(context: object, email: str) -> None:
    context.authorized_connection_clip_member = email
    _pending_behavior("connection authorized and clipped to proposer ceiling")


@then("proposing a connection outside the member authority ceiling is refused")
def then_propose_connection_outside_ceiling_refused(context: object) -> None:
    _pending_behavior("connection proposal refused outside ceiling")


@then('the connection proposal escalates to "{email}"')
def then_connection_proposal_escalates_to(context: object, email: str) -> None:
    context.authorized_connection_escalation_target = email
    _pending_behavior("escalate connection proposal to nearest covering member")


@then("no organization member ceiling covers the connection")
def then_no_member_ceiling_covers_connection(context: object) -> None:
    _pending_behavior("detect uncovered connection proposal")


@then(
    "the connection proposal stays blocked until a member with sufficient "
    "standing approves it"
)
def then_connection_proposal_stays_blocked(context: object) -> None:
    _pending_behavior("block connection proposal until sufficient standing")
