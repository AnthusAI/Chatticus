"""Unit tests for turn recovery and idempotent enqueue."""

from __future__ import annotations

from datetime import timedelta

import pytest

from chatticus.control_plane import ControlPlane
from chatticus.models import (
    StaleAttemptError,
    TurnEventKind,
    TurnReconcilingError,
    TurnStatus,
)
from chatticus.turn_recovery import logical_enqueue_id


def _recovery_plane() -> ControlPlane:
    return ControlPlane(
        attempt_lease=timedelta(seconds=60),
        turn_deadline=timedelta(seconds=120),
        max_recovery_attempts=1,
        recovery_enabled=True,
    )


def test_logical_enqueue_is_idempotent() -> None:
    plane = _recovery_plane()
    bot = plane.create_bot("anthus", "ryan", "Assistant")
    channel = plane.create_channel("anthus", "ryan", [bot.bot_id])
    from chatticus.models import ActorKind

    _, started = plane.post_channel_message(
        channel.channel_id,
        "anthus",
        ActorKind.HUMAN,
        "ryan",
        "hello",
        addressed_to_bot_id=bot.bot_id,
    )
    assert started is not None
    job = plane.job_for_turn("anthus", started.turn_id)
    assert job is not None
    enqueue_id = logical_enqueue_id(started.turn_id)
    assert plane.logical_enqueue_delivery_count == 1
    assert not plane.request_logical_enqueue("anthus", started.turn_id, enqueue_id, job)
    assert plane.logical_enqueue_delivery_count == 1


def test_deadline_recovery_enqueues_once() -> None:
    plane = _recovery_plane()
    bot = plane.create_bot("anthus", "ryan", "Assistant")
    channel = plane.create_channel("anthus", "ryan", [bot.bot_id])
    from chatticus.models import ActorKind

    _, started = plane.post_channel_message(
        channel.channel_id,
        "anthus",
        ActorKind.HUMAN,
        "ryan",
        "hello",
        addressed_to_bot_id=bot.bot_id,
    )
    assert started is not None
    plane.claim_turn_attempt("anthus", started.turn_id, "worker-a")
    plane.post_turn_chunk(
        started.turn_id,
        "anthus",
        "partial ",
        fence_token=1,
    )
    plane.advance_seconds(61)
    plane.handle_turn_deadline("anthus", started.turn_id)
    turn = plane.turn("anthus", started.turn_id)
    assert turn.status == TurnStatus.ACTIVE
    assert turn.recovery_attempts == 1
    assert plane.logical_enqueue_delivery_count == 2
    with pytest.raises(StaleAttemptError):
        plane.post_turn_chunk(
            started.turn_id,
            "anthus",
            "zombie ",
            fence_token=1,
        )


def test_deadline_failure_after_recovery_exhausted() -> None:
    plane = _recovery_plane()
    bot = plane.create_bot("anthus", "ryan", "Assistant")
    channel = plane.create_channel("anthus", "ryan", [bot.bot_id])
    from chatticus.models import ActorKind

    _, started = plane.post_channel_message(
        channel.channel_id,
        "anthus",
        ActorKind.HUMAN,
        "ryan",
        "hello",
        addressed_to_bot_id=bot.bot_id,
    )
    assert started is not None
    turn = plane.turn("anthus", started.turn_id)
    turn.recovery_attempts = 1
    plane._messaging_store.put_turn(turn)
    plane.claim_turn_attempt("anthus", started.turn_id, "worker-a")
    plane.advance_seconds(61)
    plane.handle_turn_deadline("anthus", started.turn_id)
    turn = plane.turn("anthus", started.turn_id)
    assert turn.status == TurnStatus.FAILED
    events = plane.list_turn_events("anthus", started.turn_id)
    assert any(event.kind == TurnEventKind.TURN_FAILED for event in events)


def test_ambiguous_provider_enters_reconciliation() -> None:
    plane = _recovery_plane()
    bot = plane.create_bot("anthus", "ryan", "Assistant")
    channel = plane.create_channel("anthus", "ryan", [bot.bot_id])
    from chatticus.models import ActorKind

    _, started = plane.post_channel_message(
        channel.channel_id,
        "anthus",
        ActorKind.HUMAN,
        "ryan",
        "hello",
        addressed_to_bot_id=bot.bot_id,
    )
    assert started is not None
    plane.claim_turn_attempt("anthus", started.turn_id, "worker-a")
    plane.record_ambiguous_provider_outcome("anthus", started.turn_id, "call-1")
    plane.advance_seconds(61)
    plane.handle_turn_deadline("anthus", started.turn_id)
    turn = plane.turn("anthus", started.turn_id)
    assert turn.status == TurnStatus.RECONCILING
    with pytest.raises(TurnReconcilingError):
        plane.attempt_consequential_action("anthus", started.turn_id, "send")


def test_renew_extends_lease_and_records_visibility() -> None:
    plane = _recovery_plane()
    bot = plane.create_bot("anthus", "ryan", "Assistant")
    channel = plane.create_channel("anthus", "ryan", [bot.bot_id])
    from chatticus.models import ActorKind

    _, started = plane.post_channel_message(
        channel.channel_id,
        "anthus",
        ActorKind.HUMAN,
        "ryan",
        "hello",
        addressed_to_bot_id=bot.bot_id,
    )
    assert started is not None
    attempt = plane.claim_turn_attempt("anthus", started.turn_id, "worker-a")
    assert attempt is not None
    job = plane.job_for_turn("anthus", started.turn_id)
    assert job is not None
    renewed = plane.renew_turn_lease(
        "anthus",
        started.turn_id,
        "worker-a",
        attempt.fence_token,
        job=job,
    )
    assert renewed is not None
    turn = plane.turn("anthus", started.turn_id)
    assert turn.lease_expires_at is not None
    assert turn.lease_expires_at > plane.now()
    assert ("anthus", started.turn_id) in plane.queue_visibility_renewals


def test_computerless_worker_renews_during_slow_model_call() -> None:
    from chatticus.http.app import create_app
    from chatticus.http.client import HttpTurnClient
    from chatticus.http.test_server import start_test_server
    from chatticus.worker.computerless import (
        ComputerlessWorker,
        FakeTextCompletionClient,
        SlowTextCompletionClient,
    )

    plane = _recovery_plane()
    app = create_app(plane)
    api = start_test_server(app)
    bot = plane.create_bot("anthus", "ryan", "Assistant")
    channel = plane.create_channel("anthus", "ryan", [bot.bot_id])
    from chatticus.models import ActorKind

    _, started = plane.post_channel_message(
        channel.channel_id,
        "anthus",
        ActorKind.HUMAN,
        "ryan",
        "hello",
        addressed_to_bot_id=bot.bot_id,
    )
    assert started is not None
    job = plane.job_for_turn("anthus", started.turn_id)
    assert job is not None
    slow = SlowTextCompletionClient(
        FakeTextCompletionClient(),
        plane=plane,
        advance_seconds=61,
    )
    worker = ComputerlessWorker(
        plane,
        HttpTurnClient(api, channel.tenant_id),
        slow,
    )
    worker.run_job(job)
    turn = plane.turn("anthus", started.turn_id)
    assert turn.status == TurnStatus.COMPLETED
    assert turn.lease_expires_at is not None
    assert turn.lease_expires_at > plane.now()
    assert ("anthus", started.turn_id) in plane.queue_visibility_renewals
    api.close()


def test_deadline_recovery_skips_legitimately_waiting_turn() -> None:
    plane = _recovery_plane()
    bot = plane.create_bot("anthus", "ryan", "Assistant")
    channel = plane.create_channel("anthus", "ryan", [bot.bot_id])
    from chatticus.models import ActorKind

    _, started = plane.post_channel_message(
        channel.channel_id,
        "anthus",
        ActorKind.HUMAN,
        "ryan",
        "hello",
        addressed_to_bot_id=bot.bot_id,
    )
    assert started is not None
    attempt = plane.claim_turn_attempt("anthus", started.turn_id, "worker-a")
    assert attempt is not None
    plane.emit_turn_waiting("anthus", started.turn_id, "browser", fence_token=1)
    plane.release_turn_claim_for_waiting("anthus", started.turn_id, fence_token=1)
    turn = plane.turn("anthus", started.turn_id)
    turn.recovery_attempts = 1
    plane._messaging_store.put_turn(turn)
    plane.advance_seconds(61)
    plane.handle_turn_deadline("anthus", started.turn_id)
    turn = plane.turn("anthus", started.turn_id)
    assert turn.status == TurnStatus.ACTIVE
    assert turn.waiting_for == "browser"
    assert turn.recovery_attempts == 1


def test_renewing_completion_client_renews_during_blocking_call() -> None:
    import time

    from chatticus.worker.computerless import (
        CompletionOutcome,
        FakeTextCompletionClient,
        RenewingTextCompletionClient,
    )

    renewals = 0

    def renew() -> None:
        nonlocal renewals
        renewals += 1

    class BlockingCompletionClient:
        def complete(self, prompt: str) -> CompletionOutcome:
            del prompt
            time.sleep(0.05)
            return FakeTextCompletionClient().complete("hello")

    client = RenewingTextCompletionClient(
        BlockingCompletionClient(),
        renew,
        interval_seconds=0.01,
    )
    outcome = client.complete("hello")
    assert outcome.text
    assert renewals >= 2
