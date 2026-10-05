"""Behave steps for the thin-turn demo CLI conversation client."""

from __future__ import annotations

import threading

from behave import then, when
from messaging_steps import _channel, _turn_id

from chatticus.http.client import HttpTurnClient
from chatticus.http.paths import org_path
from chatticus.models import ActorKind, primary_human_participant
from chatticus.thin_turn_conversation import (
    ThinTurnConversationClient,
    TurnWatchOutcome,
)
from chatticus.worker.computerless import ComputerlessWorker, FakeTextCompletionClient


def _demo_client(context: object) -> ThinTurnConversationClient:
    client = getattr(context, "demo_client", None)
    if client is None:
        channel = _channel(context)
        client = ThinTurnConversationClient(
            tenant_id=channel.tenant_id,
            user_id=primary_human_participant(channel),
            client=context.api_client,
        )
        context.demo_client = client
    return client


def _demo_outcome(context: object) -> TurnWatchOutcome:
    return context.demo_watch_outcome


def _run_assistant_worker(context: object) -> threading.Thread:
    channel = _channel(context)
    bot = context.bots_by_name["Assistant"]

    def run_worker() -> None:
        worker = ComputerlessWorker(
            context.plane,
            HttpTurnClient(context.api_client, channel.tenant_id),
            FakeTextCompletionClient(),
        )
        worker.complete_pending_for_bot(bot.bot_id)

    thread = threading.Thread(target=run_worker, daemon=True)
    thread.start()
    return thread


@when("the demo client watches the turn stream for that channel")
def when_demo_watches_turn(context: object) -> None:
    turn_id = _turn_id(context)
    demo = _demo_client(context)
    thread = _run_assistant_worker(context)
    context.demo_watch_outcome = demo.watch_turn_with_reconnect(turn_id)
    thread.join(timeout=5.0)


@when("the demo client watches the turn stream until one token arrives then drops")
def when_demo_watches_until_one_token(context: object) -> None:
    turn_id = _turn_id(context)
    demo = _demo_client(context)
    thread = _run_assistant_worker(context)
    context.demo_watch_outcome = demo.watch_turn_stream(
        turn_id,
        stop_after_token_count=1,
    )
    thread.join(timeout=5.0)


@when("the demo client reconnects to the same turn from stored chunks")
def when_demo_reconnects(context: object) -> None:
    turn_id = _turn_id(context)
    demo = _demo_client(context)
    first = _demo_outcome(context)
    resumed = demo.watch_turn_stream(turn_id, after_seq=first.last_seq)
    merged = TurnWatchOutcome()
    merged.absorb(first.events)
    merged.absorb(resumed.events)
    context.demo_watch_outcome = merged


@then("the demo client saw turn tokens in order")
def then_demo_saw_tokens_in_order(context: object) -> None:
    outcome = _demo_outcome(context)
    token_events = [
        event for event in outcome.events if event.get("kind") == "turn.token"
    ]
    assert token_events
    assert outcome.tokens == [event["token"] for event in token_events]
    seqs = [event["seq"] for event in token_events]
    assert seqs == sorted(seqs)


@then("the demo client saw the committed bot reply")
def then_demo_saw_committed_reply(context: object) -> None:
    outcome = _demo_outcome(context)
    assert outcome.committed_body is not None
    assert outcome.committed_body.strip()
    completed = [
        event for event in outcome.events if event.get("kind") == "turn.completed"
    ]
    assert len(completed) == 1
    assert completed[0].get("body") == outcome.committed_body


@then("the committed bot reply matches the streamed tokens")
def then_committed_reply_matches_streamed_tokens(context: object) -> None:
    outcome = _demo_outcome(context)
    streamed = "".join(outcome.tokens)
    assert outcome.committed_body == streamed
    completed = [
        event for event in outcome.events if event.get("kind") == "turn.completed"
    ]
    assert len(completed) == 1
    assert completed[0].get("body") == streamed


@then("the committed bot reply is not the prior bot greeting on the channel")
def then_committed_reply_is_not_prior_greeting(context: object) -> None:
    outcome = _demo_outcome(context)
    channel = _channel(context)
    response = context.api_client.get(
        org_path(channel.tenant_id, f"/channels/{channel.channel_id}/messages"),
    )
    assert response.status_code == 200
    bot_messages = [
        message
        for message in response.json()["messages"]
        if message["author_kind"] == ActorKind.BOT
    ]
    assert len(bot_messages) >= 2
    assert outcome.committed_body != bot_messages[0]["body"]


@then("the demo client saw turn tokens in order without duplicate sequences")
def then_demo_saw_tokens_without_duplicate_seqs(context: object) -> None:
    outcome = _demo_outcome(context)
    seqs = [event["seq"] for event in outcome.events]
    assert len(seqs) == len(set(seqs))
    token_events = [
        event for event in outcome.events if event.get("kind") == "turn.token"
    ]
    assert token_events
    token_seqs = [event["seq"] for event in token_events]
    assert token_seqs == sorted(token_seqs)


@then(
    'the demo client lists in-flight turns for user "{user_id}" of tenant '
    '"{tenant_id}":'
)
def then_demo_lists_in_flight_turns(
    context: object, user_id: str, tenant_id: str
) -> None:
    opened_ids: list[str] = getattr(context, "opened_turn_ids", [])

    def resolve_cell(cell: str) -> str:
        value = cell.strip()
        if value.isdigit():
            return opened_ids[int(value) - 1]
        return value

    expected_ids: list[str] = []
    if context.table.headings and context.table.headings[0].strip():
        expected_ids.append(resolve_cell(context.table.headings[0]))
    expected_ids.extend(resolve_cell(row.cells[0]) for row in context.table)
    expected_ids = [turn_id for turn_id in expected_ids if turn_id]
    demo = ThinTurnConversationClient(
        tenant_id=tenant_id,
        user_id=user_id,
        client=context.api_client,
    )
    listed_ids = [turn["turn_id"] for turn in demo.list_active_turns()]
    assert listed_ids == sorted(expected_ids)
