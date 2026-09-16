"""Heartbeat, idle backoff, and the give-up point for turn SSE streams.

These drive the real `stream_turn` endpoint through the HTTP server with an
injected clock. They deliberately do NOT reimplement the streaming loop: a test
that re-states the logic it is checking passes when the feature is deleted.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
from http_test_support import start_authed_test_server

from chatticus.control_plane import ControlPlane
from chatticus.http.app import StreamClock, StreamTiming
from chatticus.http.paths import org_path
from chatticus.models import ActorKind, TurnEventKind


class FakeClock(StreamClock):
    """Virtual time: sleeping advances the clock instead of waiting."""

    def __init__(self) -> None:
        self._now = 1000.0
        self.sleeps: list[float] = []

    def now(self) -> float:
        return self._now

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self._now += seconds
        # Yield to the event loop. Without this the virtual sleep never suspends,
        # so a runaway stream starves the server and a client read timeout can
        # never be serviced - the failure would hang instead of failing.
        await asyncio.sleep(0)


class ScriptedEventsPlane:
    """Wrap a real plane, scripting only what `list_turn_events` returns."""

    def __init__(self, plane: ControlPlane, script: list[list[Any]]) -> None:
        self._plane = plane
        self._script = script
        self.polls = 0

    def __getattr__(self, name: str) -> Any:
        return getattr(self._plane, name)

    def list_turn_events(self, tenant_id: str, turn_id: str, cursor: int) -> list[Any]:
        self.polls += 1
        if self._script:
            return self._script.pop(0)
        return []


def _start_turn(api: Any, plane: ControlPlane) -> tuple[str, str]:
    """Create a bot, a channel, and an unclaimed turn. Returns (turn_id, channel_id)."""
    bot = plane.create_bot("anthus", "Researcher", creator_user_id="ryan")
    channel = plane.create_channel("anthus", "ryan", [bot.bot_id])
    posted = api.post(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "hello",
            "addressed_to_bot_id": bot.bot_id,
        },
    )
    return posted.json()["turn_id"], channel.channel_id


# A stream that never ends would hang the suite rather than fail it, so reads are
# capped. Exceeding the cap means the server did not close when it should have,
# which is a test failure with a legible message - never an infinite wait.
_MAX_FRAMES = 2000


def _read_stream(
    api: Any, tenant_id: str, turn_id: str
) -> tuple[list[str], list[dict]]:
    """Return (raw lines, parsed events). Fails if the server never closes."""
    raw: list[str] = []
    events: list[dict] = []
    frames = 0
    # A read timeout is the only bound that also catches a stream producing no
    # bytes at all: the frame cap above cannot fire if nothing is ever emitted.
    try:
        stream = api.stream(
            "GET",
            org_path(tenant_id, f"/turns/{turn_id}/stream"),
            timeout=httpx.Timeout(10.0, read=5.0),
        )
    except TypeError:  # pragma: no cover - client without timeout support
        stream = api.stream("GET", org_path(tenant_id, f"/turns/{turn_id}/stream"))
    try:
        with stream as response:
            assert response.headers["content-type"].startswith("text/event-stream")
            buffer = ""
            for chunk in response.iter_bytes():
                buffer += chunk.decode()
                while "\n\n" in buffer:
                    frame, buffer = buffer.split("\n\n", 1)
                    frames += 1
                    if frames > _MAX_FRAMES:
                        raise AssertionError(
                            f"stream produced over {_MAX_FRAMES} frames "
                            "without closing; the server is not giving up"
                        )
                    for line in frame.split("\n"):
                        raw.append(line)
                        if line.startswith("data:"):
                            events.append(json.loads(line[5:].strip()))
    except httpx.ReadTimeout as timed_out:
        raise AssertionError(
            "server never closed the stream; it is not giving up when it should"
        ) from timed_out
    return raw, events


def test_idle_stream_emits_heartbeat_comments() -> None:
    """A quiet stream puts bytes on the wire so idle timeouts do not kill it."""
    plane = ControlPlane()
    clock = FakeClock()
    api = start_authed_test_server(
        plane,
        environment=None,
        invoke_key="",
        stream_clock=clock,
        stream_timing=StreamTiming(heartbeat_interval=15.0, idle_timeout=60.0),
    )
    turn_id, _channel_id = _start_turn(api, plane)
    raw, _ = _read_stream(api, "anthus", turn_id)
    api.close()

    heartbeats = [line for line in raw if line.startswith(":")]
    assert heartbeats, "an idle stream must emit heartbeat comments"
    # 60s of idle time at one heartbeat per 15s.
    assert len(heartbeats) >= 3, f"expected repeated heartbeats, got {len(heartbeats)}"


def test_idle_stream_gives_up_with_reconciling_not_failed() -> None:
    """Giving up says 'go re-read', never 'the turn failed' - we do not know that."""
    plane = ControlPlane()
    clock = FakeClock()
    api = start_authed_test_server(
        plane,
        environment=None,
        invoke_key="",
        stream_clock=clock,
        stream_timing=StreamTiming(heartbeat_interval=5.0, idle_timeout=30.0),
    )
    turn_id, channel_id = _start_turn(api, plane)
    _, events = _read_stream(api, "anthus", turn_id)
    api.close()

    assert events, "the stream must not close silently - that wipes the transcript"
    last = events[-1]
    assert last["kind"] == TurnEventKind.TURN_RECONCILING
    assert last["kind"] != TurnEventKind.TURN_FAILED
    assert last["turn_id"] == turn_id
    assert last["channel_id"] == channel_id


def test_heartbeats_alone_do_not_hold_the_stream_open() -> None:
    """The heartbeat is our traffic; only worker events may postpone giving up."""
    plane = ControlPlane()
    clock = FakeClock()
    api = start_authed_test_server(
        plane,
        environment=None,
        invoke_key="",
        stream_clock=clock,
        # Many heartbeats fit inside the idle window.
        stream_timing=StreamTiming(heartbeat_interval=1.0, idle_timeout=20.0),
    )
    turn_id, _channel_id = _start_turn(api, plane)
    raw, events = _read_stream(api, "anthus", turn_id)
    api.close()

    assert [line for line in raw if line.startswith(":")], "expected heartbeats"
    assert (
        events[-1]["kind"] == TurnEventKind.TURN_RECONCILING
    ), "heartbeats must not keep a dead stream alive forever"


def test_poll_interval_backs_off_while_idle_and_stops_at_the_ceiling() -> None:
    """Idle polling must not hold 50ms forever, and must not grow without bound."""
    plane = ControlPlane()
    clock = FakeClock()
    api = start_authed_test_server(
        plane,
        environment=None,
        invoke_key="",
        stream_clock=clock,
        stream_timing=StreamTiming(
            heartbeat_interval=1000.0,
            idle_timeout=30.0,
            min_poll_interval=0.05,
            max_poll_interval=1.0,
        ),
    )
    turn_id, _channel_id = _start_turn(api, plane)
    _read_stream(api, "anthus", turn_id)
    api.close()

    assert clock.sleeps[0] == 0.05, f"must start at the floor, got {clock.sleeps[0]}"
    assert clock.sleeps[1] > clock.sleeps[0], "the interval must grow while idle"
    assert max(clock.sleeps) <= 1.0, "the interval must not exceed the ceiling"
    assert clock.sleeps[-1] == 1.0, "a long idle stream should reach the ceiling"


def test_poll_interval_resets_to_the_floor_when_events_arrive() -> None:
    """Backoff must collapse the moment the worker speaks, or latency degrades."""
    plane = ControlPlane()
    setup = start_authed_test_server(plane, environment=None, invoke_key="")
    turn_id, _channel_id = _start_turn(setup, plane)
    real_events = plane.list_turn_events("anthus", turn_id, 0)
    setup.close()
    assert real_events, "expected the started turn to have at least one event"

    # Idle long enough to climb toward the ceiling, then deliver one real event.
    script: list[list[Any]] = [[] for _ in range(12)]
    script.append([real_events[0]])
    scripted = ScriptedEventsPlane(plane, script)

    clock = FakeClock()
    api = start_authed_test_server(
        scripted,
        environment=None,
        invoke_key="",
        stream_clock=clock,
        stream_timing=StreamTiming(
            heartbeat_interval=1000.0,
            idle_timeout=30.0,
            min_poll_interval=0.05,
            max_poll_interval=1.0,
        ),
    )
    _read_stream(api, "anthus", turn_id)
    api.close()

    before = clock.sleeps[11]
    after = clock.sleeps[12]
    assert before > 0.05, f"expected backoff to have grown, got {before}"
    assert after == 0.05, f"expected a reset to the floor after an event, got {after}"
