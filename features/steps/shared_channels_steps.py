"""Behave steps for shared organization channels, bots, and workspace artifacts."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime

from behave import given, then, when
from browser_auth_helpers import cognito_test_keys, wire_test_http_front_door
from cognito_test_support import mint_id_token

from chatticus.http.paths import org_path
from chatticus.models import ActorKind, ChannelParticipant

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


def _auth_headers(context: object, email: str) -> dict[str, str]:
    token = mint_id_token(cognito_test_keys(context), email=email)
    return {"Authorization": f"Bearer {token}"}


def _shared_channel(context: object, channel_name: str) -> object:
    channel = getattr(context, "shared_channels_by_name", {}).get(channel_name)
    if channel is None:
        raise AssertionError(f"Unknown shared channel {channel_name!r}.")
    return channel


def _bot_ids_from_table(context: object, table: object) -> list[str]:
    names = [table.headings[0].strip()] if table.headings else []
    names.extend(row.cells[0].strip() for row in table)
    names = [name for name in names if name]
    bots_by_name = getattr(context, "bots_by_name", {})
    return [bots_by_name[name].bot_id for name in names]


def _member_emails(context: object) -> list[str]:
    return list(getattr(context, "identities_by_email", {}).keys())


def _store_shared_channel(
    context: object, channel_name: str, channel: object, *, extra_humans: list[str]
) -> object:
    participants = list(channel.participants)
    existing_humans = {
        participant.actor_id
        for participant in participants
        if participant.kind == ActorKind.HUMAN
    }
    for email in extra_humans:
        user_id = _user_id(context, email)
        if user_id not in existing_humans:
            participants.append(
                ChannelParticipant(kind=ActorKind.HUMAN, actor_id=user_id)
            )
    updated = replace(channel, participants=participants)
    context.plane._messaging_store.put_channel(updated)
    context.shared_channels_by_name[channel_name] = updated
    return updated


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


@given('organization "{name}" has shared channel "{channel_name}"')
def given_organization_shared_channel(
    context: object, name: str, channel_name: str
) -> None:
    org = _org(context, name)
    owner_id = _user_id(context, _member_emails(context)[0])
    channel = context.plane.create_channel(org.tenant_id, owner_id, [])
    _store_shared_channel(
        context,
        channel_name,
        channel,
        extra_humans=_member_emails(context)[1:],
    )


@given('organization "{name}" has organization bots:')
def given_organization_bots(context: object, name: str) -> None:
    org = _org(context, name)
    owner_id = _user_id(context, _member_emails(context)[0])
    names = [context.table.headings[0].strip()] if context.table.headings else []
    names.extend(row.cells[0].strip() for row in context.table)
    names = [bot_name for bot_name in names if bot_name]
    for bot_name in names:
        bot = context.plane.create_bot(
            org.tenant_id, bot_name, creator_user_id=owner_id
        )
        context.bots_by_name[bot_name] = bot


@given(
    'organization "{name}" has shared channel "{channel_name}" with organization bots:'
)
def given_organization_shared_channel_with_bots(
    context: object, name: str, channel_name: str
) -> None:
    org = _org(context, name)
    owner_id = _user_id(context, _member_emails(context)[0])
    bot_ids = _bot_ids_from_table(context, context.table)
    channel = context.plane.create_channel(org.tenant_id, owner_id, bot_ids)
    _store_shared_channel(
        context,
        channel_name,
        channel,
        extra_humans=_member_emails(context)[1:],
    )


@when('"{email}" posts "{body}" in shared channel "{channel_name}"')
def when_member_posts_in_shared_channel(
    context: object, email: str, body: str, channel_name: str
) -> None:
    channel = _shared_channel(context, channel_name)
    user_id = _user_id(context, email)
    context.plane.post_channel_message(
        channel.channel_id,
        channel.tenant_id,
        ActorKind.HUMAN,
        user_id,
        body,
        enqueue_turn=False,
    )


@when('"{email}" creates organization bot "{bot_name}"')
def when_member_creates_organization_bot(
    context: object, email: str, bot_name: str
) -> None:
    org = next(iter(context.orgs_by_name.values()))
    response = context.api_client.post(
        org_path(org.tenant_id, "/bots"),
        json={"name": bot_name},
        headers=_auth_headers(context, email),
    )
    if response.status_code == 200:
        payload = response.json()
        context.bots_by_name[bot_name] = context.plane.bot(
            org.tenant_id, payload["bot_id"]
        )
        context.bot_create_error = None
        return
    context.bot_create_error = response


@when(
    'organization bot "{bot_name}" writes "{path}" containing "{content}" '
    "on the organization computer"
)
def when_organization_bot_writes_file(
    context: object, bot_name: str, path: str, content: str
) -> None:
    bot = context.bots_by_name[bot_name]
    context.plane.ensure_computer(bot.tenant_id)
    context.plane.write_workspace(bot.tenant_id, path, content)


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
    channel = _shared_channel(context, channel_name)
    author_bot = context.bots_by_name[author]
    addressee_bot = context.bots_by_name[addressee]
    context.plane.post_channel_message(
        channel.channel_id,
        channel.tenant_id,
        ActorKind.BOT,
        author_bot.bot_id,
        body,
        addressed_to_bot_id=addressee_bot.bot_id,
        enqueue_turn=False,
    )


@then('"{email}" can read {count:d} messages in shared channel "{channel_name}"')
def then_member_reads_shared_channel_messages(
    context: object, email: str, count: int, channel_name: str
) -> None:
    channel = _shared_channel(context, channel_name)
    user_id = _user_id(context, email)
    response = context.api_client.get(
        org_path(channel.tenant_id, f"/channels/{channel.channel_id}/messages"),
        headers=_auth_headers(context, email),
    )
    assert response.status_code == 200, response.text
    messages = response.json()["messages"]
    assert len(messages) == count
    listed = context.plane.list_channels(channel.tenant_id, user_id)
    assert any(item.channel_id == channel.channel_id for item in listed)


@then('the shared channel message with seq {seq:d} has body "{body}"')
def then_shared_channel_message_body(context: object, seq: int, body: str) -> None:
    channel = next(iter(context.shared_channels_by_name.values()))
    message = next(
        message
        for message in context.plane.list_channel_messages(
            channel.channel_id, channel.tenant_id
        )
        if message.seq == seq
    )
    assert message.body == body


@then('"{email}" lists organization bot "{bot_name}"')
def then_member_lists_organization_bot(
    context: object, email: str, bot_name: str
) -> None:
    org = next(iter(context.orgs_by_name.values()))
    user_id = _user_id(context, email)
    response = context.api_client.get(
        org_path(org.tenant_id, f"/users/{user_id}/bots"),
        headers=_auth_headers(context, email),
    )
    assert response.status_code == 200, response.text
    names = [bot["name"] for bot in response.json()["bots"]]
    assert bot_name in names


@then('organization bot "{bot_name}" belongs to organization "{org_name}"')
def then_organization_bot_belongs_to_org(
    context: object, bot_name: str, org_name: str
) -> None:
    org = _org(context, org_name)
    bot = context.bots_by_name[bot_name]
    assert bot.tenant_id == org.tenant_id


@then('"{email}" cannot create a second organization bot named "{bot_name}"')
def then_member_cannot_duplicate_organization_bot(
    context: object, email: str, bot_name: str
) -> None:
    org = next(iter(context.orgs_by_name.values()))
    response = context.api_client.post(
        org_path(org.tenant_id, "/bots"),
        json={"name": bot_name},
        headers=_auth_headers(context, email),
    )
    assert response.status_code != 200


@then(
    'organization bot "{bot_name}" can read "{path}" as "{content}" '
    "from the organization computer"
)
def then_organization_bot_reads_file(
    context: object, bot_name: str, path: str, content: str
) -> None:
    bot = context.bots_by_name[bot_name]
    assert context.plane.read_workspace(bot.tenant_id, path) == content


@then('"{email}" can continue file "{path}" on the organization computer')
def then_member_continues_organization_file(
    context: object, email: str, path: str
) -> None:
    org = next(iter(context.orgs_by_name.values()))
    user_id = _user_id(context, email)
    del user_id
    context.plane.ensure_computer(org.tenant_id)
    existing = context.plane.read_workspace(org.tenant_id, path)
    assert existing is not None
    context.plane.write_workspace(org.tenant_id, path, f"{existing}\ncontinued")
