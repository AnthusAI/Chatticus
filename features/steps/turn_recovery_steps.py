"""Step definitions for interrupted turn recovery."""

from __future__ import annotations

from datetime import timedelta

from behave import given, then, when
from sse_helpers import SseWatcher, tenant_headers

from chatticus.control_plane import ControlPlane
from chatticus.http.app import create_app
from chatticus.http.client import HttpTurnClient
from chatticus.http.test_server import start_test_server
from chatticus.models import TurnEventKind, TurnReconcilingError, TurnStatus
from chatticus.turn_recovery import logical_enqueue_id
from chatticus.worker.computerless import (
    ComputerlessWorker,
    CountingTextCompletionClient,
)


def _channel(context: object) -> object:
    if context.last_channel is None:
        raise AssertionError("No channel is open in this scenario.")
    return context.last_channel


def _turn_id(context: object) -> str:
    if context.last_turn_id is None:
        raise AssertionError("No turn is active in this scenario.")
    return context.last_turn_id


def _claim(context: object, worker_id: str) -> None:
    channel = _channel(context)
    response = context.api_client.post(
        f"/turns/{_turn_id(context)}/claim",
        json={"worker_id": worker_id},
        headers=tenant_headers(channel.tenant_id),
    )
    assert response.status_code == 200, response.text
    context.fence_token = int(response.json()["fence_token"])
    context.active_worker_id = worker_id


def _post_chunk(
    context: object,
    token: str,
    *,
    complete: bool = False,
    fence_token: int | None = None,
) -> None:
    channel = _channel(context)
    resolved_fence = fence_token if fence_token is not None else context.fence_token
    response = context.api_client.post(
        f"/turns/{_turn_id(context)}/chunks",
        json={
            "token": token,
            "complete": complete,
            "fence_token": resolved_fence,
        },
        headers=tenant_headers(channel.tenant_id),
    )
    assert response.status_code == 200, response.text


@given("an empty control plane with turn recovery enabled")
def given_recovery_control_plane(context: object) -> None:
    context.plane = ControlPlane(
        heartbeat_timeout=timedelta(seconds=30),
        attempt_lease=timedelta(seconds=60),
        turn_deadline=timedelta(seconds=120),
        max_recovery_attempts=1,
        recovery_enabled=True,
    )
    app = create_app(context.plane)
    context.api_app = app
    context.app_state = app.state.chatticus
    context.api_client = start_test_server(app)
    context.bots_by_name = {}
    context.last_channel = None
    context.last_turn_id = None
    context.fence_token = None
    context.active_worker_id = None
    context.sse_watcher = None
    context.counting_client = CountingTextCompletionClient()


@given("a turn has committed partial progress")
def given_partial_progress(context: object) -> None:
    channel = _channel(context)
    bot = context.bots_by_name["Assistant"]
    response = context.api_client.post(
        f"/channels/{channel.channel_id}/messages",
        json={
            "author_kind": "human",
            "author_id": channel.user_id,
            "body": "hello",
            "addressed_to_bot_id": bot.bot_id,
        },
        headers=tenant_headers(channel.tenant_id),
    )
    assert response.status_code == 200
    context.last_turn_id = response.json()["turn_id"]
    _claim(context, "worker-a")
    _post_chunk(context, "partial ")
    context.partial_event_count = len(
        context.plane.list_turn_events(channel.tenant_id, _turn_id(context))
    )
    watcher = SseWatcher(context.api_client, _turn_id(context), channel.tenant_id)
    watcher.start()
    watcher.wait_for_events(2, timeout=2.0)
    context.sse_watcher = watcher


@given("its active worker stops without completing")
def given_worker_stops(context: object) -> None:
    context.plane.advance_seconds(61)


@given("recovery has already been attempted once")
def given_recovery_already_attempted(context: object) -> None:
    turn = context.plane.turn(_channel(context).tenant_id, _turn_id(context))
    turn.recovery_attempts = 1
    context.plane._messaging_store.put_turn(turn)


@when("the turn deadline is reached")
def when_turn_deadline_reached(context: object) -> None:
    context.plane.advance_seconds(61)


@then("exactly one later attempt resumes after the last committed event")
def then_one_recovery_attempt(context: object) -> None:
    channel = _channel(context)
    turn_id = _turn_id(context)
    assert context.plane.logical_enqueue_delivery_count == 2
    turn = context.plane.turn(channel.tenant_id, turn_id)
    assert turn.status == TurnStatus.ACTIVE
    assert turn.recovery_attempts == 1
    events = context.plane.list_turn_events(channel.tenant_id, turn_id)
    assert len(events) == context.partial_event_count
    chunks = context.plane._messaging_store.list_turn_chunks(channel.tenant_id, turn_id)
    assert chunks == ["partial "]
    context.counting_client = CountingTextCompletionClient()
    worker = ComputerlessWorker(
        context.plane,
        HttpTurnClient(context.api_client, channel.tenant_id),
        context.counting_client,
    )
    job = context.plane.job_for_turn(channel.tenant_id, turn_id)
    assert job is not None
    worker.run_job(job)
    assert context.counting_client.calls == 1
    turn = context.plane.turn(channel.tenant_id, turn_id)
    assert turn.status == TurnStatus.COMPLETED


@then("the turn reaches a visible failed state with a reason")
def then_turn_failed_with_reason(context: object) -> None:
    channel = _channel(context)
    turn = context.plane.turn(channel.tenant_id, _turn_id(context))
    assert turn.status == TurnStatus.FAILED
    assert turn.terminal_reason
    events = context.plane.list_turn_events(channel.tenant_id, _turn_id(context))
    assert any(event.kind == TurnEventKind.TURN_FAILED for event in events)


@then("the watcher does not remain open indefinitely")
def then_watcher_closes(context: object) -> None:
    if context.sse_watcher is None:
        return
    context.sse_watcher.wait_for_kind(
        ("turn.completed", "turn.failed", "turn.reconciling"),
        timeout=5.0,
    )
    assert context.sse_watcher.closed or any(
        event.get("kind") in ("turn.completed", "turn.failed", "turn.reconciling")
        for event in context.sse_watcher.events
    )


@given("a turn is waiting on an ambiguous provider outcome")
def given_ambiguous_provider(context: object) -> None:
    channel = _channel(context)
    bot = context.bots_by_name["Assistant"]
    response = context.api_client.post(
        f"/channels/{channel.channel_id}/messages",
        json={
            "author_kind": "human",
            "author_id": channel.user_id,
            "body": "send the report",
            "addressed_to_bot_id": bot.bot_id,
        },
        headers=tenant_headers(channel.tenant_id),
    )
    assert response.status_code == 200
    context.last_turn_id = response.json()["turn_id"]
    _claim(context, "worker-a")
    context.plane.record_ambiguous_provider_outcome(
        channel.tenant_id,
        _turn_id(context),
        "provider-call-1",
    )
    context.plane.advance_seconds(61)


@when("recovery cannot prove the outcome")
def when_recovery_cannot_prove(context: object) -> None:
    channel = _channel(context)
    context.plane.handle_turn_deadline(channel.tenant_id, _turn_id(context))


@then("the turn requests reconciliation")
def then_turn_requests_reconciliation(context: object) -> None:
    channel = _channel(context)
    turn = context.plane.turn(channel.tenant_id, _turn_id(context))
    assert turn.status == TurnStatus.RECONCILING
    events = context.plane.list_turn_events(channel.tenant_id, _turn_id(context))
    assert any(event.kind == TurnEventKind.TURN_RECONCILING for event in events)


@then("the system does not silently repeat a consequential operation")
def then_no_silent_repeat(context: object) -> None:
    channel = _channel(context)
    try:
        context.plane.attempt_consequential_action(
            channel.tenant_id,
            _turn_id(context),
            "send",
        )
    except TurnReconcilingError:
        return
    raise AssertionError("Expected consequential action to be blocked.")


@when("the same logical enqueue is requested twice for one turn")
def when_duplicate_logical_enqueue(context: object) -> None:
    channel = _channel(context)
    bot = context.bots_by_name["Assistant"]
    response = context.api_client.post(
        f"/channels/{channel.channel_id}/messages",
        json={
            "author_kind": "human",
            "author_id": channel.user_id,
            "body": "hello",
            "addressed_to_bot_id": bot.bot_id,
        },
        headers=tenant_headers(channel.tenant_id),
    )
    assert response.status_code == 200
    context.last_turn_id = response.json()["turn_id"]
    job = context.plane.job_for_turn(channel.tenant_id, _turn_id(context))
    assert job is not None
    enqueue_id = logical_enqueue_id(_turn_id(context))
    context.plane.request_logical_enqueue(
        channel.tenant_id, _turn_id(context), enqueue_id, job
    )
    context.plane.request_logical_enqueue(
        channel.tenant_id, _turn_id(context), enqueue_id, job
    )


@then("only one queue delivery is recorded")
def then_one_queue_delivery(context: object) -> None:
    assert context.plane.logical_enqueue_delivery_count == 1


@given("a worker owns an active turn")
def given_worker_owns_turn(context: object) -> None:
    channel = _channel(context)
    bot = context.bots_by_name["Assistant"]
    response = context.api_client.post(
        f"/channels/{channel.channel_id}/messages",
        json={
            "author_kind": "human",
            "author_id": channel.user_id,
            "body": "hello",
            "addressed_to_bot_id": bot.bot_id,
        },
        headers=tenant_headers(channel.tenant_id),
    )
    assert response.status_code == 200
    context.last_turn_id = response.json()["turn_id"]
    _claim(context, "worker-a")
    context.active_job = context.plane.job_for_turn(
        channel.tenant_id, _turn_id(context)
    )


@when("the fenced owner calls the renew API")
def when_fenced_owner_calls_renew_api(context: object) -> None:
    channel = _channel(context)
    client = HttpTurnClient(context.api_client, channel.tenant_id, context.fence_token)
    client.renew(
        _turn_id(context),
        context.active_worker_id,
        job_id=context.active_job.job_id,
    )


@then("its turn claim is extended")
def then_claim_extended(context: object) -> None:
    channel = _channel(context)
    turn = context.plane.turn(channel.tenant_id, _turn_id(context))
    assert turn.lease_expires_at is not None
    assert turn.lease_expires_at > context.plane.now()


@then("its queue visibility is extended")
def then_visibility_extended(context: object) -> None:
    channel = _channel(context)
    renewals = context.plane.queue_visibility_renewals
    assert (channel.tenant_id, _turn_id(context)) in renewals
