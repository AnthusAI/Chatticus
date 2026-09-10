"""Behave steps for enabled-member turn grant replacement over HTTP."""

from __future__ import annotations

import json

from behave import given, then, when
from browser_auth_helpers import browser_user_auth_headers, ensure_org_membership
from http_test_support import NOW

from chatticus.capability_policy import (
    grant_to_payload,
    household_conversation_grant,
    parse_grant_table,
)
from chatticus.http.paths import org_path
from chatticus.models import ActorKind, Identity, MemberRole, Membership, TurnEventKind
from chatticus.org_records import normalize_email


def _table_map(context: object) -> dict[str, str]:
    table = context.table
    values = {table.headings[0].strip(): table.headings[1].strip()}
    for row in table:
        values[row.cells[0].strip()] = row.cells[1].strip()
    return values


def _grant_payload_from_table(context: object) -> dict[str, list[str]]:
    grant = parse_grant_table(_table_map(context))
    return grant_to_payload(grant)


def _active_turn_id(context: object) -> str:
    turn_id = getattr(context, "last_turn_id", None)
    if turn_id is None:
        raise AssertionError("No turn is active in this scenario.")
    return turn_id


def _active_tenant_id(context: object) -> str:
    channel = getattr(context, "last_channel", None)
    if channel is not None:
        return channel.tenant_id
    bot = next(iter(getattr(context, "bots_by_name", {}).values()), None)
    if bot is not None:
        return bot.tenant_id
    return "anthus"


def _actor_user_id(context: object, tenant_id: str, user_label: str) -> str:
    from http_test_support import _seed_org_for_user

    from chatticus.models import OrganizationNotFoundError

    try:
        context.plane.get_organization(tenant_id)
    except OrganizationNotFoundError:
        member_email = normalize_email(f"{user_label}@{tenant_id}.test")
        _seed_org_for_user(
            context.plane,
            tenant_id,
            user_label,
            owner_email=member_email,
        )
    email = ensure_org_membership(context, tenant_id, preferred_user_id=user_label)
    identity = context.plane._org_records.store.get_identity_by_email(
        normalize_email(email)
    )
    if identity is None:
        msg = f"No identity for {user_label!r} in tenant {tenant_id!r}."
        raise AssertionError(msg)
    return identity.user_id


@given('tenant "{tenant_id}" user "{user_id}" is an enabled member')
def given_enabled_member(context: object, tenant_id: str, user_id: str) -> None:
    from chatticus.models import OrganizationNotFoundError

    owner_email = normalize_email(f"org-owner@{tenant_id}.test")
    try:
        context.plane.get_organization(tenant_id)
    except OrganizationNotFoundError:
        context.plane.admin_seed_organization(
            tenant_id,
            owner_email,
            name=tenant_id,
            now=NOW,
        )
    member_email = normalize_email(f"{user_id}@{tenant_id}.test")
    member_identity = Identity(user_id=user_id, email=member_email, created_at=NOW)
    context.plane._messaging_store.put_identity(member_identity)
    context.plane._messaging_store.put_membership(
        Membership(
            tenant_id=tenant_id,
            user_id=user_id,
            role=MemberRole.MEMBER,
            joined_at=NOW,
        )
    )


@given('user "{user_id}" of tenant "{tenant_id}" has a grant standing ceiling of:')
def given_grant_standing_ceiling(context: object, user_id: str, tenant_id: str) -> None:
    actor_user_id = _actor_user_id(context, tenant_id, user_id)
    context.plane.set_member_grant_bounds_ceiling(
        tenant_id,
        actor_user_id,
        grant_table=_table_map(context),
    )


@given(
    'user "{user_id}" of tenant "{tenant_id}" has started a turn with the '
    "household conversation grant"
)
def given_started_turn_with_conversation_grant(
    context: object, user_id: str, tenant_id: str
) -> None:
    from membership_helpers import ensure_messaging_user_membership
    from messaging_steps import _load_channel

    bot_name = next(iter(context.bots_by_name))
    bot = context.bots_by_name[bot_name]
    actor_user_id = _actor_user_id(context, tenant_id, user_id)
    ensure_messaging_user_membership(context.plane, tenant_id, user_id)
    auth_headers = browser_user_auth_headers(
        context, tenant_id, preferred_user_id=user_id
    )
    response = context.api_client.post(
        org_path(tenant_id, "/channels"),
        json={
            "user_id": actor_user_id,
            "bot_ids": [bot.bot_id],
            "kind": "direct",
            "name": None,
        },
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    channel_id = response.json()["channel_id"]
    _load_channel(context, tenant_id, channel_id)
    channel = context.last_channel
    message_response = context.api_client.post(
        org_path(tenant_id, f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": actor_user_id,
            "body": "hello",
            "addressed_to_bot_id": bot.bot_id,
        },
        headers=auth_headers,
    )
    assert message_response.status_code == 200, message_response.text
    context.last_turn_id = message_response.json().get("turn_id")
    grant = context.plane.capability_policy_for(
        tenant_id, _active_turn_id(context)
    ).grant
    assert grant == household_conversation_grant()


@when('user "{user_id}" of tenant "{tenant_id}" replaces the active turn grant with:')
def when_user_replaces_active_turn_grant(
    context: object, user_id: str, tenant_id: str
) -> None:
    payload = _grant_payload_from_table(context)
    response = context.api_client.put(
        org_path(tenant_id, f"/turns/{_active_turn_id(context)}/grant"),
        json=payload,
        headers=browser_user_auth_headers(
            context, tenant_id, preferred_user_id=user_id
        ),
    )
    context.grant_http_response = response
    context.last_grant_table = _table_map(context)


@when(
    'user "{user_id}" of tenant "{tenant_id}" replaces the active turn grant '
    "with tools beyond that standing"
)
def when_user_replaces_beyond_standing(
    context: object, user_id: str, tenant_id: str
) -> None:
    payload = grant_to_payload(
        parse_grant_table(
            {
                "tools": "read_workspace, browse",
                "origins": "https://docs.example.com",
                "recipients": "",
                "file_scopes": "/workspace",
                "egress_classes": "approved_origin_fetch",
            }
        )
    )
    response = context.api_client.put(
        org_path(tenant_id, f"/turns/{_active_turn_id(context)}/grant"),
        json=payload,
        headers=browser_user_auth_headers(
            context, tenant_id, preferred_user_id=user_id
        ),
    )
    context.grant_http_response = response


@when("an unauthenticated caller PUTs the active turn grant on the user route")
def when_unauthenticated_put_active_turn_grant(context: object) -> None:
    tenant_id = _active_tenant_id(context)
    payload = grant_to_payload(household_conversation_grant())
    response = context.raw_api_client.put(
        org_path(tenant_id, f"/turns/{_active_turn_id(context)}/grant"),
        json=payload,
    )
    context.grant_http_response = response


@when(
    'user "{user_id}" of tenant "{tenant_id}" PUTs a turn grant over HTTP '
    'for turn "{turn_id}":'
)
def when_user_puts_turn_grant_for_turn(
    context: object, user_id: str, tenant_id: str, turn_id: str
) -> None:
    payload = _grant_payload_from_table(context)
    response = context.api_client.put(
        org_path(tenant_id, f"/turns/{turn_id}/grant"),
        json=payload,
        headers=browser_user_auth_headers(
            context, tenant_id, preferred_user_id=user_id
        ),
    )
    context.grant_http_response = response


@then("the active turn grant is exactly that table")
def then_active_turn_grant_matches_table(context: object) -> None:
    tenant_id = _active_tenant_id(context)
    turn_id = _active_turn_id(context)
    expected = parse_grant_table(context.last_grant_table)
    grant = context.plane.capability_policy_for(tenant_id, turn_id).grant
    assert grant == expected


@then('the active turn grant does not include tool "{tool}"')
def then_active_turn_grant_excludes_tool(context: object, tool: str) -> None:
    tenant_id = _active_tenant_id(context)
    turn_id = _active_turn_id(context)
    grant = context.plane.capability_policy_for(tenant_id, turn_id).grant
    assert grant is not None
    assert tool not in grant.tools


@then('the turn journal records a grant replacement by user "{user_label}"')
def then_turn_journal_records_grant_replacement(
    context: object, user_label: str
) -> None:
    tenant_id = _active_tenant_id(context)
    turn_id = _active_turn_id(context)
    actor_user_id = _actor_user_id(context, tenant_id, user_label)
    events = context.plane.list_turn_events(tenant_id, turn_id)
    replacements = [
        event for event in events if event.kind == TurnEventKind.TURN_GRANT_REPLACED
    ]
    assert replacements, "expected a turn.grant.replaced journal event"
    body = json.loads(replacements[-1].body or "{}")
    assert body["actor_user_id"] == actor_user_id
    assert "tools" in body


@then("the active turn still carries the household conversation grant")
def then_active_turn_still_carries_conversation_grant(context: object) -> None:
    tenant_id = _active_tenant_id(context)
    turn_id = _active_turn_id(context)
    grant = context.plane.capability_policy_for(tenant_id, turn_id).grant
    assert grant == household_conversation_grant()


@then("the turn journal does not record a grant replacement")
def then_turn_journal_does_not_record_grant_replacement(context: object) -> None:
    tenant_id = _active_tenant_id(context)
    turn_id = _active_turn_id(context)
    events = context.plane.list_turn_events(tenant_id, turn_id)
    replacements = [
        event for event in events if event.kind == TurnEventKind.TURN_GRANT_REPLACED
    ]
    assert not replacements
