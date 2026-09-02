"""Tests for integration-test SSE frame parsing."""

from __future__ import annotations

from chatticus.integration_test.sse import parse_sse_frames


def test_parse_sse_frames_returns_events_and_remainder() -> None:
    buffer = (
        'data: {"kind":"turn.started","seq":1}\n\n'
        'data: {"kind":"turn.token","seq":2}\n\npartial'
    )
    events, remainder = parse_sse_frames(buffer)
    assert len(events) == 2
    assert events[0]["kind"] == "turn.started"
    assert events[1]["seq"] == 2
    assert remainder == "partial"
