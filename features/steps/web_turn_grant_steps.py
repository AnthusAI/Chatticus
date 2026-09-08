"""Behave steps for replacing active turn grants from the enabled workspace web SPA."""

from __future__ import annotations

import json

from behave import given, then, when
from web_create_bot_steps import (
    given_enabled_workspace_web_spa,
    when_web_spa_creates_bot,
)
from web_organization_signup_steps import _run_harness

from chatticus.models import TurnEventKind


@given('the web SPA creates bot "{name}"')
def given_web_spa_creates_bot(context: object, name: str) -> None:
    when_web_spa_creates_bot(context, name)


def _table_map(context: object) -> dict[str, str]:
    table = context.table
    values = {table.headings[0].strip(): table.headings[1].strip()}
    for row in table:
        values[row.cells[0].strip()] = row.cells[1].strip()
    return values


def _harness_payload(context: object) -> dict[str, str]:
    api_base = getattr(context, "web_api_base", None)
    token = getattr(context, "web_id_token", None)
    if api_base is None or token is None:
        raise AssertionError(
            "web API base and id token must be wired for this scenario"
        )
    org = next(iter(getattr(context, "orgs_by_name", {}).values()), None)
    payload = {"api_base": api_base, "id_token": token}
    if org is not None:
        payload["tenant_id"] = org.tenant_id
    return payload


def _sync_turn_context(context: object) -> None:
    harness = context.membership_ui_harness
    turn_id = harness.get("activeTurnId")
    assert turn_id, harness
    context.last_turn_id = turn_id
    org = next(iter(context.orgs_by_name.values()))
    bots = context.plane.list_bots(org.tenant_id)
    bot_id = harness.get("workspaceBotId")
    bot = next((item for item in bots if item.bot_id == bot_id), bots[0])
    context.bots_by_name = {bot.name: bot}
    channel_id = harness.get("workspaceChannelId")
    if channel_id is not None:
        context.last_channel = context.plane.channel(org.tenant_id, channel_id)


@given('the enabled workspace web SPA with an active turn for "{email}" in "{name}"')
def given_enabled_workspace_with_active_turn(
    context: object, email: str, name: str
) -> None:
    given_enabled_workspace_web_spa(context, email, name)
    context.membership_ui_harness = _run_harness(
        "setup-active-turn",
        _harness_payload(context),
    )
    _sync_turn_context(context)


@given("the signed-in member has a grant standing ceiling of:")
def given_signed_in_grant_standing_ceiling(context: object) -> None:
    org = next(iter(context.orgs_by_name.values()))
    identity = context.current_identity
    assert identity is not None
    context.plane.set_member_grant_bounds_ceiling(
        org.tenant_id,
        identity.user_id,
        grant_table=_table_map(context),
    )


@when("the web SPA replaces the active turn grant with:")
def when_web_spa_replaces_active_turn_grant(context: object) -> None:
    payload = _harness_payload(context)
    payload.update(_table_map(context))
    context.membership_ui_harness = _run_harness("submit-turn-grant", payload)
    context.last_grant_table = context.membership_ui_harness.get("lastGrantTable")
    _sync_turn_context(context)


@when("the web SPA replaces the active turn grant with run_terminal checked and:")
def when_web_spa_replaces_turn_grant_with_terminal(context: object) -> None:
    payload = _harness_payload(context)
    payload.update(_table_map(context))
    payload["run_terminal"] = "true"
    context.membership_ui_harness = _run_harness("submit-turn-grant", payload)
    context.last_grant_table = context.membership_ui_harness.get("lastGrantTable")
    _sync_turn_context(context)


@when("the web SPA replaces the active turn grant with tools beyond that standing")
def when_web_spa_replaces_beyond_standing(context: object) -> None:
    context.membership_ui_harness = _run_harness(
        "submit-turn-grant-beyond-standing",
        _harness_payload(context),
    )
    _sync_turn_context(context)


@when("the web SPA tries to replace the active turn grant with an empty tool list")
def when_web_spa_tries_empty_turn_grant(context: object) -> None:
    context.membership_ui_harness = _run_harness(
        "try-submit-empty-turn-grant",
        _harness_payload(context),
    )


@when(
    "PUT /turns/{turn_id}/grant is called with an empty tools list for the active turn"
)
def when_put_turn_grant_empty_tools(context: object, turn_id: str) -> None:
    del turn_id
    context.membership_ui_harness = _run_harness(
        "put-turn-grant-http",
        _harness_payload(context),
    )


@then('the web SPA shows turn grant confirmation for "{tools_csv}"')
def then_web_turn_grant_confirmation(context: object, tools_csv: str) -> None:
    harness = context.membership_ui_harness
    expected_tools = sorted(
        part.strip() for part in tools_csv.split(",") if part.strip()
    )
    expected = f"Turn grant updated: {', '.join(expected_tools)}."
    assert harness.get("turnGrantConfirmation") == expected, harness


@then("the web SPA shows a turn grant error")
def then_web_turn_grant_error(context: object) -> None:
    harness = context.membership_ui_harness
    assert harness.get("turnGrantError"), harness


@then("the web SPA did not call replace turn grant")
def then_web_did_not_call_replace_turn_grant(context: object) -> None:
    harness = context.membership_ui_harness
    assert harness.get("turnGrantBlocked") is True, harness
    assert harness.get("turnGrantConfirmation") is None, harness


@then("the web SPA does not show the turn grant form")
def then_web_does_not_show_turn_grant_form(context: object) -> None:
    harness = context.membership_ui_harness
    assert harness.get("turnGrantFormVisible") is not True, harness
    text = harness.get("visibleText") or ""
    assert "Authorize this turn" not in text, harness


@then('the active turn grant includes tool "{tool}"')
def then_active_turn_grant_includes_tool(context: object, tool: str) -> None:
    org = next(iter(context.orgs_by_name.values()))
    grant = context.plane.capability_policy_for(
        org.tenant_id, context.last_turn_id
    ).grant
    assert grant is not None
    assert tool in grant.tools


@then("the turn journal records a grant replacement by the signed-in member")
def then_turn_journal_records_replacement_by_signed_in(context: object) -> None:
    org = next(iter(context.orgs_by_name.values()))
    identity = context.current_identity
    assert identity is not None
    events = context.plane.list_turn_events(org.tenant_id, context.last_turn_id)
    replacements = [
        event for event in events if event.kind == TurnEventKind.TURN_GRANT_REPLACED
    ]
    assert replacements, "expected a turn.grant.replaced journal event"
    body = json.loads(replacements[-1].body or "{}")
    assert body["actor_user_id"] == identity.user_id
    assert "tools" in body


@then("the active turn grant has no tools")
def then_active_turn_grant_has_no_tools(context: object) -> None:
    org = next(iter(context.orgs_by_name.values()))
    grant = context.plane.capability_policy_for(
        org.tenant_id, context.last_turn_id
    ).grant
    assert grant is not None
    assert grant.tools == frozenset()


@then("PUT /turns/{turn_id}/grant responds with status {status:d}")
def then_put_turn_grant_status(context: object, turn_id: str, status: int) -> None:
    del turn_id
    harness = context.membership_ui_harness
    assert harness.get("turnGrantHttpStatus") == status, harness
    _sync_turn_context(context)
