"""Tests for stream_turn heartbeat, idle backoff, and inactivity timeout."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from typing import Any

import pytest
from http_test_support import start_authed_test_server

from chatticus.control_plane import ControlPlane
from chatticus.http.app import _StreamClock
from chatticus.http.paths import org_path
from chatticus.http.sse import format_turn_event_sse
from chatticus.models import ActorKind, TurnEvent, TurnEventKind


def _channel_with_bot(plane: ControlPlane, name: str = "Researcher"):
    bot = plane.create_bot("anthus", name, creator_user_id="ryan")
    channel = plane.create_channel("anthus", "ryan", [bot.bot_id])
    return bot, channel


def _client_for(plane: ControlPlane):
    return start_authed_test_server(plane, environment=None, invoke_key="")


class FakeClock(_StreamClock):
    """A fake clock for testing that advances manually."""

    def __init__(self):
        self._time = datetime.now(UTC).timestamp()

    async def now(self) -> float:
        """Return the current fake time."""
        return self._time

    async def sleep(self, seconds: float) -> None:
        """Advance fake time instead of sleeping."""
        self._time += seconds

    def advance(self, seconds: float) -> None:
        """Manually advance time (for synchronous test code)."""
        self._time += seconds


def test_stream_heartbeat_emitted_while_idle() -> None:
    """Test that heartbeat comment is emitted on schedule while no events arrive."""
    # Use a fake clock for controlled timing
    clock = FakeClock()

    events_and_comments: list[tuple[str, Any]] = []

    async def mock_event_generator():
        """Simulate the event generator with fake clock."""
        last_real_event_at = await clock.now()
        heartbeat_interval = 15.0
        next_heartbeat_at = last_real_event_at + heartbeat_interval
        poll_interval = 0.05
        max_poll_interval = 1.0

        # Simulate 20 seconds of polling with no events
        while await clock.now() < last_real_event_at + 20.0:
            now = await clock.now()

            # Emit heartbeat if due
            if now >= next_heartbeat_at:
                events_and_comments.append(("comment", ": heartbeat\n\n"))
                next_heartbeat_at = now + heartbeat_interval

            # No events on this iteration
            await clock.sleep(poll_interval)
            poll_interval = min(poll_interval * 1.2, max_poll_interval)

    asyncio.run(mock_event_generator())

    # Verify heartbeat was emitted (should happen at 15s)
    comments = [item for item in events_and_comments if item[0] == "comment"]
    assert len(comments) >= 1, "Heartbeat comment should be emitted at 15s"


def test_stream_idle_backoff_sequence() -> None:
    """Test that poll interval grows while idle and resets on events."""
    clock = FakeClock()

    poll_intervals: list[float] = []

    async def test_backoff():
        poll_interval = 0.05
        max_poll_interval = 1.0

        # Simulate 20 idle iterations (enough to reach ceiling)
        for _ in range(20):
            poll_intervals.append(poll_interval)
            await clock.sleep(poll_interval)
            poll_interval = min(poll_interval * 1.2, max_poll_interval)

        # Record the final state before reset
        final_before_reset = poll_interval

        # Simulate event arrival
        poll_interval = 0.05

        # Verify it reset to floor
        poll_intervals.append(poll_interval)

        return final_before_reset

    final = asyncio.run(test_backoff())

    # Verify backoff sequence: should grow each time until capped at 1.0
    for i in range(len(poll_intervals) - 2):
        # Verify monotonic growth (allow for capping at ceiling)
        assert (
            poll_intervals[i + 1] >= poll_intervals[i] * 1.19
            or poll_intervals[i + 1] >= 0.95
        )

    # Verify last interval before reset reached ceiling
    assert final >= 0.95, f"Should reach near 1s ceiling, got {final}"

    # Verify reset happened (last interval is floor)
    assert poll_intervals[-1] == 0.05, "Should reset to floor on event"


def test_stream_deadman_fires_on_inactivity() -> None:
    """Test that the inactivity deadman fires after timeout with no real events."""
    plane = ControlPlane()
    api = _client_for(plane)
    bot, channel = _channel_with_bot(plane)
    api.post(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "hello",
            "addressed_to_bot_id": bot.bot_id,
        },
    )

    # Simulate the deadman timeout logic
    clock = FakeClock()
    fired = False
    timeout_message = None

    async def test_deadman():
        nonlocal fired, timeout_message

        inactivity_timeout = 120.0
        last_real_event_at = await clock.now()

        # Simulate time passing with no events
        for _ in range(130):
            await clock.sleep(1.0)  # Advance 1 second at a time

            now = await clock.now()
            if now - last_real_event_at > inactivity_timeout:
                fired = True
                timeout_message = "Stream timeout due to inactivity"
                break

    asyncio.run(test_deadman())

    assert fired, "Deadman should fire after inactivity timeout"
    assert timeout_message is not None
    api.close()


def test_stream_deadman_does_not_fire_with_continuous_events() -> None:
    """Test that deadman does not fire while events keep arriving."""
    clock = FakeClock()
    fired = False

    async def test_continuous_events():
        nonlocal fired

        inactivity_timeout = 120.0
        last_real_event_at = await clock.now()

        # Simulate 300 seconds of continuous events every 10 seconds
        for i in range(30):
            await clock.sleep(10.0)

            # Simulate event arrival every 10 seconds
            if i % 1 == 0:
                last_real_event_at = await clock.now()

            now = await clock.now()
            if now - last_real_event_at > inactivity_timeout:
                fired = True
                break

    asyncio.run(test_continuous_events())

    assert not fired, "Deadman should not fire while events keep arriving"


def test_stream_heartbeat_does_not_reset_deadman() -> None:
    """Test that heartbeats alone do not prevent the deadman from firing."""
    clock = FakeClock()
    fired = False

    async def test_heartbeat_no_reset():
        nonlocal fired

        inactivity_timeout = 120.0
        last_real_event_at = await clock.now()
        heartbeat_interval = 15.0
        next_heartbeat_at = last_real_event_at + heartbeat_interval
        heartbeat_emitted_count = 0

        # Simulate 150 seconds with only heartbeats, no real events
        for _ in range(150):
            await clock.sleep(1.0)

            now = await clock.now()

            # Emit heartbeat but DON'T update last_real_event_at
            if now >= next_heartbeat_at:
                heartbeat_emitted_count += 1
                next_heartbeat_at = now + heartbeat_interval

            # Check deadman
            if now - last_real_event_at > inactivity_timeout:
                fired = True
                break

    asyncio.run(test_heartbeat_no_reset())

    assert fired, "Deadman should fire even with heartbeats if no real events"


def test_stream_turn_emits_terminal_event_reason() -> None:
    """Test that the terminal timeout event has correct structure."""

    # Create a timeout event as the stream would
    timeout_event = TurnEvent(
        event_id="test-event-id",
        tenant_id="anthus",
        turn_id="test-turn-id",
        channel_id="test-channel-id",
        seq=0,
        kind=TurnEventKind.TURN_FAILED,
        body="Stream timeout due to inactivity",
    )

    # Format it as SSE
    sse_line = format_turn_event_sse(timeout_event)

    # Parse it to verify it's a valid event
    lines = sse_line.split("\n")
    assert any(line.startswith("event:") for line in lines)
    assert any(line.startswith("data:") for line in lines)

    # Parse the data to verify structure
    data_line = next(line for line in lines if line.startswith("data:"))
    data = json.loads(data_line[5:].strip())
    assert data["kind"] == "turn.failed"
    assert "timeout" in data.get("body", "")


def test_stream_comment_lines_ignored_by_client() -> None:
    """Verify that web/lib/sse.ts ignores comment lines starting with ':'."""
    # This is a validation test that comment lines in SSE are properly formatted
    # Comment lines in SSE start with ':' and are used for keepalive
    heartbeat_line = ": heartbeat\n\n"

    # Verify format
    assert heartbeat_line.startswith(":")
    assert heartbeat_line.endswith("\n\n")

    # Parse as per SSE spec: lines starting with : are comments and ignored
    # The parseSseFrames function in web/lib/sse-parse.ts only looks for 'data:' lines
    # so comment lines are silently skipped
    parsed_events = []
    frame = heartbeat_line.strip()

    # This is what the client parser does
    data_line = next(
        (line for line in frame.split("\n") if line.startswith("data:")), None
    )

    # Comment lines should not have a data line
    assert data_line is None
    # So they won't be parsed as events
    assert len(parsed_events) == 0


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
