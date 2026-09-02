"""Behave steps for authorized connections between organizations."""

from __future__ import annotations

from datetime import UTC, datetime

from behave import given, then, when
from browser_auth_helpers import ensure_org_membership, wire_test_http_front_door

from chatticus.authorized_connections import ConnectionProposalStatus

NOW = datetime(2026, 8, 31, 12, 0, 0, tzinfo=UTC)


def _org(context: object, name: str) -> object:
    org = getattr(context, "orgs_by_name", {}).get(name)
    if org is None:
        raise AssertionError(f"Unknown organization {name!r}.")
    return org


def _user_id(context: object, email: str) -> str:
    identity = getattr(context, "identities_by_email", {}).get(email)
    if identity is None:
        raise AssertionError(f"Unknown member {email!r}.")
    return identity.user_id


def _shared_channel(context: object, channel_name: str) -> object:
    channel = getattr(context, "shared_channels_by_name", {}).get(channel_name)
    if channel is None:
        raise AssertionError(f"Unknown shared channel {channel_name!r}.")
    return channel


def _propose_connection(
    context: object,
    *,
    email: str,
    receiving_org: str,
    channel_name: str,
    granting_org: str,
    try_only: bool,
) -> None:
    granting = _org(context, granting_org)
    receiving = _org(context, receiving_org)
    channel = _shared_channel(context, channel_name)
    proposer_user_id = _user_id(context, email)
    if try_only:
        result = context.plane.try_propose_connection(
            granting.tenant_id,
            proposer_user_id,
            receiving.tenant_id,
            channel.channel_id,
            channel_name,
        )
    else:
        result = context.plane.propose_connection(
            granting.tenant_id,
            proposer_user_id,
            receiving.tenant_id,
            channel.channel_id,
            channel_name,
        )
    context.connection_proposal_result = result
    context.connection_proposal = result.proposal
    context.connection_route = result.route


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
    _propose_connection(
        context,
        email=email,
        receiving_org=receiving_org,
        channel_name=channel_name,
        granting_org=granting_org,
        try_only=False,
    )


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
    _propose_connection(
        context,
        email=email,
        receiving_org=receiving_org,
        channel_name=channel_name,
        granting_org=granting_org,
        try_only=True,
    )


@when("the connection proposal is routed for approval")
def when_connection_proposal_routed_for_approval(context: object) -> None:
    proposal = context.connection_proposal
    assert proposal is not None
    context.connection_route = context.plane.route_connection_proposal(
        proposal.proposal_id
    )


@then('the connection is authorized and clipped to "{email}" ceiling')
def then_connection_authorized_and_clipped(context: object, email: str) -> None:
    result = context.connection_proposal_result
    assert result is not None
    assert result.authorized is not None
    assert result.route is not None
    assert result.route.status == ConnectionProposalStatus.AUTHORIZED
    assert result.authorized.clipped_by_user_id == _user_id(context, email)
    proposal = result.proposal
    assert proposal is not None
    assert result.authorized.channel_name == proposal.channel_name
    assert result.authorized.receiving_tenant_id == proposal.receiving_tenant_id


@then("proposing a connection outside the member authority ceiling is refused")
def then_propose_connection_outside_ceiling_refused(context: object) -> None:
    result = context.connection_proposal_result
    assert result is not None
    assert result.refused is True
    assert result.authorized is None
    assert result.route is not None
    assert result.route.status == ConnectionProposalStatus.REFUSED
    assert context.plane.refused_connections()


@then('the connection proposal escalates to "{email}"')
def then_connection_proposal_escalates_to(context: object, email: str) -> None:
    route = context.connection_route
    assert route is not None
    assert route.status == ConnectionProposalStatus.PENDING_ESCALATION
    assert route.escalation_target_user_id == _user_id(context, email)


@then("no organization member ceiling covers the connection")
def then_no_member_ceiling_covers_connection(context: object) -> None:
    route = context.connection_route
    assert route is not None
    assert route.status == ConnectionProposalStatus.BLOCKED
    assert route.escalation_target_user_id is None


@then(
    "the connection proposal stays blocked until a member with sufficient "
    "standing approves it"
)
def then_connection_proposal_stays_blocked(context: object) -> None:
    assert context.plane.authorized_connections() == []
