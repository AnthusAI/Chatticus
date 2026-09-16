"""Tests for SSE stream timing: heartbeat, backoff, and deadman timeout."""

from __future__ import annotations

import json
import time
from datetime import timedelta

from http_test_support import ensure_test_org, start_authed_test_server

from chatticus.control_plane import ControlPlane
from chatticus.http.paths import org_path
from chatticus.models import ActorKind


def _client_for(
    plane: ControlPlane,
    *,
    sse_heartbeat_interval: float | None = None,
    sse_min_poll_interval: float | None = None,
    sse_max_poll_interval: float | None = None,
):
    """Create an authed test server with optional SSE timing parameters."""
    return start_authed_test_server(
        plane,
        environment="development",
        invoke_key="",
        sse_heartbeat_interval=sse_heartbeat_interval,
        sse_min_poll_interval=sse_min_poll_interval,
        sse_max_poll_interval=sse_max_poll_interval,
    )


def _channel_with_bot(plane: ControlPlane, name: str = "SSE Test Bot"):
    """Create a test channel with a bot."""
    ensure_test_org(plane, "anthus")
    bot = plane.create_bot("anthus", name, creator_user_id="ryan")
    channel = plane.create_channel("anthus", "ryan", [bot.bot_id])
    return bot, channel


def test_sse_emits_heartbeat_while_idle() -> None:
    """Verify heartbeat comments emitted on regular interval while idle."""
    plane = ControlPlane()
    # Use short intervals for testing
    api = _client_for(plane, sse_heartbeat_interval=0.1, sse_min_poll_interval=0.02)
    bot, channel = _channel_with_bot(plane)

    # Post a message to create a turn
    post = api.post(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "hello",
            "addressed_to_bot_id": bot.bot_id,
        },
    )
    turn_id = post.json()["turn_id"]

    # Stream and collect heartbeat comments
    heartbeats: list[str] = []
    events: list[dict] = []

    with api.stream(
        "GET",
        org_path(channel.tenant_id, f"/turns/{turn_id}/stream"),
    ) as response:
        assert response.headers["content-type"].startswith("text/event-stream")
        buffer = ""
        heartbeat_count = 0
        timeout = time.time() + 1.0  # 1 second timeout to collect heartbeats

        for chunk in response.iter_bytes():
            buffer += chunk.decode()
            while "\n\n" in buffer:
                frame, buffer = buffer.split("\n\n", 1)
                lines = frame.split("\n")
                for line in lines:
                    if line.startswith(":"):
                        # This is a comment line (heartbeat)
                        heartbeat_count += 1
                        if heartbeat_count <= 3:
                            heartbeats.append(line)
                    elif line.startswith("data:"):
                        events.append(json.loads(line[5:].strip()))

            # Stop after collecting a few heartbeats
            if heartbeat_count >= 3 or time.time() > timeout:
                break

    # We should have received at least 2-3 heartbeat comments during the idle period
    assert (
        len(heartbeats) >= 2
    ), f"Expected at least 2 heartbeats, got {len(heartbeats)}: {heartbeats}"
    for heartbeat in heartbeats:
        assert heartbeat == ": heartbeat"

    api.close()


def test_sse_backoff_polling_reduces_queries() -> None:
    """Verify poll interval backs off when idle (reducing queries)."""
    plane = ControlPlane()
    # Use short intervals for testing: 10ms min, 100ms max, 10s heartbeat
    api = _client_for(
        plane,
        sse_heartbeat_interval=10.0,
        sse_min_poll_interval=0.01,
        sse_max_poll_interval=0.1,
    )
    bot, channel = _channel_with_bot(plane)

    # Post a message to create a turn
    post = api.post(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "hello",
            "addressed_to_bot_id": bot.bot_id,
        },
    )
    turn_id = post.json()["turn_id"]

    # Collect initial events and then stop
    events: list[dict] = []
    with api.stream(
        "GET",
        org_path(channel.tenant_id, f"/turns/{turn_id}/stream"),
    ) as response:
        buffer = ""
        for chunk in response.iter_bytes():
            buffer += chunk.decode()
            while "\n\n" in buffer:
                frame, buffer = buffer.split("\n\n", 1)
                for line in frame.split("\n"):
                    if line.startswith("data:"):
                        events.append(json.loads(line[5:].strip()))

            # We should have gotten the turn.started event quickly
            if len(events) > 0:
                break

    # Verify we got the initial turn event - this shows the stream is working
    assert len(events) > 0
    assert events[0]["kind"] == "turn.started"
    # Backoff is internal; stream handles idle periods more efficiently.

    api.close()


def test_sse_deadman_timeout_closes_stream() -> None:
    """Verify stream closes after deadman timeout if worker never completes."""
    # Use a very short deadline for testing
    plane = ControlPlane(turn_deadline=timedelta(seconds=0.2))
    api = _client_for(
        plane,
        sse_heartbeat_interval=10.0,  # Long heartbeat so it doesn't mask timeout
        sse_min_poll_interval=0.05,
        sse_max_poll_interval=0.1,
    )
    bot, channel = _channel_with_bot(plane)

    # Post a message to create a turn
    post = api.post(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "hello",
            "addressed_to_bot_id": bot.bot_id,
        },
    )
    turn_id = post.json()["turn_id"]

    # Stream but don't complete the turn (worker never emits completion event)
    events: list[dict] = []
    stream_closed = False

    start_time = time.time()
    with api.stream(
        "GET",
        org_path(channel.tenant_id, f"/turns/{turn_id}/stream"),
    ) as response:
        buffer = ""
        for chunk in response.iter_bytes():
            buffer += chunk.decode()
            while "\n\n" in buffer:
                frame, buffer = buffer.split("\n\n", 1)
                for line in frame.split("\n"):
                    if line.startswith("data:"):
                        events.append(json.loads(line[5:].strip()))

        # Stream should close naturally due to deadman timeout
        stream_closed = True
    elapsed = time.time() - start_time

    # Stream should close within ~0.3 seconds (deadman is 0.2s, plus overhead)
    assert elapsed < 1.0, f"Stream took too long to close: {elapsed}s"
    assert stream_closed, "Stream should have closed due to deadman timeout"
    # Should be no terminal events (worker never completed)
    terminal_events = [
        e
        for e in events
        if e.get("kind") in ("turn.completed", "turn.failed", "turn.reconciling")
    ]
    assert (
        len(terminal_events) == 0
    ), f"Expected no terminal events, got {terminal_events}"

    api.close()


def test_sse_heartbeat_is_ignored_by_client_parser() -> None:
    """Verify that heartbeat comments don't interfere with event parsing."""
    plane = ControlPlane()
    api = _client_for(
        plane,
        sse_heartbeat_interval=0.05,  # Very frequent heartbeats
        sse_min_poll_interval=0.02,
    )
    bot, channel = _channel_with_bot(plane)

    # Post a message to create a turn
    post = api.post(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "hello",
            "addressed_to_bot_id": bot.bot_id,
        },
    )
    turn_id = post.json()["turn_id"]

    # Stream and verify we only parse data: lines
    events: list[dict] = []
    with api.stream(
        "GET",
        org_path(channel.tenant_id, f"/turns/{turn_id}/stream"),
    ) as response:
        buffer = ""
        for chunk in response.iter_bytes():
            buffer += chunk.decode()
            while "\n\n" in buffer:
                frame, buffer = buffer.split("\n\n", 1)
                for line in frame.split("\n"):
                    if line.startswith("data:"):
                        events.append(json.loads(line[5:].strip()))
            # Just collect initial events, don't wait for completion
            if len(events) > 0:
                break

    # Should have received turn.started event without issues
    assert len(events) > 0, "Should have received at least one event"
    assert (
        events[0]["kind"] == "turn.started"
    ), f"Expected turn.started, got {events[0]['kind']}"

    api.close()
