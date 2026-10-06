"""Behave steps that replace an active turn grant over HTTP."""

from __future__ import annotations

from behave import then, when
from browser_auth_helpers import browser_user_auth_headers

from chatticus.capability_policy import grant_to_payload, parse_grant_table
from chatticus.http.paths import org_path


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
