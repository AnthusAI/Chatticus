"""Tests for the thin-turn demo conversation client."""

from __future__ import annotations

from chatticus.http.app import INVOKE_HEADER
from chatticus.thin_turn_conversation import (
    TurnWatchOutcome,
    front_door_headers,
    parse_sse_data_frames,
)


def test_front_door_headers_include_invoke_key_when_set() -> None:
    headers = front_door_headers("secret")
    assert headers == {INVOKE_HEADER: "secret"}


def test_front_door_headers_omit_invoke_key_when_missing() -> None:
    assert front_door_headers() == {}


def test_parse_sse_data_frames_splits_partial_buffers() -> None:
    frame = (
        "event: turn.token\nid: 2\ndata: "
        '{"kind":"turn.token","seq":2,"token":"lo"}\n\n'
    )
    first, rest = parse_sse_data_frames(frame[:20])
    assert first == []
    assert rest == frame[:20]
    events, leftover = parse_sse_data_frames(rest + frame[20:])
    assert len(events) == 1
    assert events[0]["kind"] == "turn.token"
    assert events[0]["token"] == "lo"
    assert leftover == ""


def test_turn_watch_outcome_tracks_tokens_and_body() -> None:
    outcome = TurnWatchOutcome()
    outcome.absorb(
        [
            {"kind": "turn.started", "seq": 1},
            {"kind": "turn.token", "seq": 2, "token": "Hel"},
            {"kind": "turn.token", "seq": 3, "token": "lo"},
            {"kind": "turn.completed", "seq": 4, "body": "Hello"},
        ]
    )
    assert outcome.tokens == ["Hel", "lo"]
    assert outcome.committed_body == "Hello"
    assert outcome.last_seq == 4
