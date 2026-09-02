"""Behave steps for shared organization channels, bots, and workspace artifacts."""

from __future__ import annotations

from datetime import UTC, datetime

from behave import given, then, when
from behave.exception import StepNotImplementedError
from browser_auth_helpers import ensure_org_membership

NOW = datetime(2026, 8, 31, 12, 0, 0, tzinfo=UTC)


def _pending(reason: str) -> None:
    """Mark a step as pending until shared-channel behavior is implemented."""
    raise StepNotImplementedError(reason)


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
    ensure_org_membership(context, tenant_id, owner_email=owner_email)
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


@given('organization "{name}" has shared channel "{channel_name}"')
def given_organization_shared_channel(
    context: object, name: str, channel_name: str
) -> None:
    _pending(f"shared channel {channel_name!r} for organization {name!r}")


@given('organization "{name}" has organization bots:')
def given_organization_bots(context: object, name: str) -> None:
    _pending(f"organization bots for {name!r}")


@given(
    'organization "{name}" has shared channel "{channel_name}" with organization bots:'
)
def given_organization_shared_channel_with_bots(
    context: object, name: str, channel_name: str
) -> None:
    _pending(f"shared channel {channel_name!r} with organization bots for {name!r}")


@when('"{email}" posts "{body}" in shared channel "{channel_name}"')
def when_member_posts_in_shared_channel(
    context: object, email: str, body: str, channel_name: str
) -> None:
    _pending(f"{email} posting in shared channel {channel_name!r}")


@when('"{email}" creates organization bot "{bot_name}"')
def when_member_creates_organization_bot(
    context: object, email: str, bot_name: str
) -> None:
    _pending(f"{email} creating organization bot {bot_name!r}")


@when(
    'organization bot "{bot_name}" writes "{path}" containing "{content}" '
    "on the organization computer"
)
def when_organization_bot_writes_file(
    context: object, bot_name: str, path: str, content: str
) -> None:
    _pending(f"organization bot {bot_name!r} writing {path!r}")


@when(
    'organization bot "{author}" posts "{body}" addressed to organization bot '
    '"{addressee}" in shared channel "{channel_name}"'
)
def when_organization_bot_posts_in_shared_channel(
    context: object,
    author: str,
    body: str,
    addressee: str,
    channel_name: str,
) -> None:
    _pending(
        f"organization bot {author!r} posting to {addressee!r} "
        f"in shared channel {channel_name!r}"
    )


@then('"{email}" can read {count:d} messages in shared channel "{channel_name}"')
def then_member_reads_shared_channel_messages(
    context: object, email: str, count: int, channel_name: str
) -> None:
    _pending(f"{email} reading {count} messages in shared channel {channel_name!r}")


@then('the shared channel message with seq {seq:d} has body "{body}"')
def then_shared_channel_message_body(context: object, seq: int, body: str) -> None:
    _pending(f"shared channel message seq {seq} body {body!r}")


@then('"{email}" lists organization bot "{bot_name}"')
def then_member_lists_organization_bot(
    context: object, email: str, bot_name: str
) -> None:
    _pending(f"{email} listing organization bot {bot_name!r}")


@then('organization bot "{bot_name}" belongs to organization "{org_name}"')
def then_organization_bot_belongs_to_org(
    context: object, bot_name: str, org_name: str
) -> None:
    _pending(f"organization bot {bot_name!r} belongs to {org_name!r}")


@then('"{email}" cannot create a second organization bot named "{bot_name}"')
def then_member_cannot_duplicate_organization_bot(
    context: object, email: str, bot_name: str
) -> None:
    _pending(f"{email} cannot duplicate organization bot {bot_name!r}")


@then(
    'organization bot "{bot_name}" can read "{path}" as "{content}" '
    "from the organization computer"
)
def then_organization_bot_reads_file(
    context: object, bot_name: str, path: str, content: str
) -> None:
    _pending(f"organization bot {bot_name!r} reading {path!r}")


@then('"{email}" can continue file "{path}" on the organization computer')
def then_member_continues_organization_file(
    context: object, email: str, path: str
) -> None:
    _pending(f"{email} continuing file {path!r} on the organization computer")
