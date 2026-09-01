"""Behave steps for capability-gated model tool loop dispatch."""

from __future__ import annotations

from behave import then, when

from chatticus.http.app import create_app
from chatticus.http.test_server import start_test_server
from chatticus.models import TurnEventKind

_SECRET_MARKERS = ("session", "cookie", "token", "password", "secret")


@when('bot "{bot_name}" is asked "{message}"')
def when_bot_is_asked_for_model_sink(
    context: object, bot_name: str, message: str
) -> None:
    from chatticus.models import ActorKind

    bot = context.bots_by_name[bot_name]
    channel = context.plane.create_channel(bot.tenant_id, bot.user_id, [bot.bot_id])
    _, turn = context.plane.post_channel_message(
        channel.channel_id,
        bot.tenant_id,
        ActorKind.HUMAN,
        bot.user_id,
        body=message,
        addressed_to_bot_id=bot.bot_id,
    )
    assert turn is not None
    context.last_turn_id = turn.turn_id
    context.last_channel = channel
    context.worker_bot_id = bot.bot_id
    context.policy_turn_id = turn.turn_id
    source_grant = context.plane.capability_policy_for(
        bot.tenant_id, "model-sink-turn"
    ).grant
    if source_grant is not None:
        context.plane.set_turn_capability_grant(
            bot.tenant_id, turn.turn_id, source_grant
        )


@when('bot "{bot_name}" runs one capability-aware computerless worker turn')
def when_capability_aware_worker_turn(context: object, bot_name: str) -> None:
    from chatticus.http.client import HttpTurnClient
    from chatticus.worker.computerless import (
        CapabilityAwareFakeTextCompletionClient,
        ComputerlessWorker,
    )

    bot = context.bots_by_name[bot_name]
    if not hasattr(context, "api_client"):
        context.api_client = start_test_server(create_app(context.plane, invoke_key=""))
    worker = ComputerlessWorker(
        context.plane,
        HttpTurnClient(context.api_client, bot.tenant_id),
        CapabilityAwareFakeTextCompletionClient(),
    )
    worker.complete_pending_for_bot(bot.bot_id)
    context.last_turn_id = context.last_turn_id or _active_turn_id(context, bot.bot_id)


@then('the bot answer includes "{snippet}"')
def then_bot_answer_includes(context: object, snippet: str) -> None:
    from chatticus.models import ActorKind

    turn = context.plane.turn("anthus", context.last_turn_id)
    messages = context.plane.list_channel_messages(turn.channel_id, turn.tenant_id)
    bot_bodies = [
        message.body
        for message in messages
        if message.author_kind == ActorKind.BOT and message.body
    ]
    assert bot_bodies
    assert any(snippet in body for body in bot_bodies)


@then("the turn journal records a successful read_workspace tool result")
def then_successful_read_workspace_journal(context: object) -> None:
    events = context.plane.list_turn_events("anthus", context.last_turn_id)
    results = [
        event
        for event in events
        if event.kind == TurnEventKind.TOOL_RESULT
        and event.body
        and event.body.startswith("read_workspace:")
    ]
    assert results
    assert not results[-1].body.startswith("denied:")


@then("the turn journal records a denied {tool_name} tool result")
def then_denied_tool_journal(context: object, tool_name: str) -> None:
    events = context.plane.list_turn_events("anthus", context.last_turn_id)
    calls = [
        event
        for event in events
        if event.kind == TurnEventKind.TOOL_CALL and event.body == tool_name
    ]
    results = [
        event
        for event in events
        if event.kind == TurnEventKind.TOOL_RESULT
        and event.body
        and event.body.startswith("denied:")
    ]
    assert calls
    assert results
    assert calls[-1].action_id == results[-1].action_id


@then("the denied tool result does not leak session secrets")
def then_denied_result_safe(context: object) -> None:
    events = context.plane.list_turn_events("anthus", context.last_turn_id)
    denied = next(
        event.body
        for event in reversed(events)
        if event.kind == TurnEventKind.TOOL_RESULT
        and event.body
        and event.body.startswith("denied:")
    )
    lowered = denied.lower()
    assert not any(marker in lowered for marker in _SECRET_MARKERS)


def _active_turn_id(context: object, bot_id: str) -> str:
    for turn_id, tenant_id in context.plane._turn_tenants.items():
        turn = context.plane.turn(tenant_id, turn_id)
        if turn.bot_id == bot_id and turn.status.value == "completed":
            return turn_id
    msg = f"No completed turn found for bot {bot_id!r}."
    raise AssertionError(msg)
