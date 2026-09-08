"""Behave steps for per-task run_terminal grant replace policy coverage."""

from __future__ import annotations

from behave import then

from chatticus.models import TurnEventKind

_NOT_GRANTED = "denied: tool 'run_terminal' is not granted"


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


@then("the turn is not denied for lack of run_terminal on the grant")
def then_not_denied_for_lack_of_run_terminal(context: object) -> None:
    tenant_id = _active_tenant_id(context)
    turn_id = _active_turn_id(context)
    events = context.plane.list_turn_events(tenant_id, turn_id)
    calls = [
        event
        for event in events
        if event.kind == TurnEventKind.TOOL_CALL and event.body == "run_terminal"
    ]
    not_granted = [
        event
        for event in events
        if event.kind == TurnEventKind.TOOL_RESULT
        and event.body
        and _NOT_GRANTED in event.body
    ]
    assert calls, "expected a run_terminal tool call after grant replace"
    assert (
        not not_granted
    ), "run_terminal was denied for missing grant after human replace"
