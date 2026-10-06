"""Step definition for seeding an organization with enabled members."""

from __future__ import annotations

from datetime import UTC, datetime

from behave import given
from browser_auth_helpers import wire_test_http_front_door

NOW = datetime(2026, 8, 31, 12, 0, 0, tzinfo=UTC)


@given('organization "{name}" with tenant "{tenant_id}" has enabled members:')
def given_organization_with_enabled_members(
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
    context.orgs_by_name = {name: org}
    context.identities_by_email = {owner_email: owner}
    context.shared_channels_by_name = {}
    context.bots_by_name = getattr(context, "bots_by_name", {})
    context.bot_create_error = None
    from browser_auth_helpers import ensure_org_membership

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
        context.identities_by_email[email] = member
