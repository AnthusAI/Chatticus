"""Tests for the thin-turn demo conversation client."""

from __future__ import annotations

import httpx

from chatticus.http.app import INVOKE_HEADER
from chatticus.http.paths import org_path
from chatticus.thin_turn_conversation import (
    ThinTurnConversationClient,
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


def test_post_message_uses_org_scoped_channel_path() -> None:
    captured: dict[str, str] = {}

    def fake_post(path: str, **kwargs: object) -> httpx.Response:
        captured["path"] = path
        return httpx.Response(
            200,
            request=httpx.Request("POST", f"https://example.test{path}"),
            json={"turn_id": "turn-1", "message": {"message_id": "msg-1"}},
        )

    client = ThinTurnConversationClient(
        tenant_id="anthus",
        user_id="ryan",
        base_url="https://example.test",
    )
    client._client.post = fake_post  # type: ignore[method-assign]
    turn_id, message_id = client.post_message("chan-1", "hello", "bot-1")
    assert turn_id == "turn-1"
    assert message_id == "msg-1"
    assert captured["path"] == org_path("anthus", "/channels/chan-1/messages")


def test_list_channel_messages_uses_org_scoped_channel_path() -> None:
    captured: dict[str, str] = {}

    def fake_get(path: str, **kwargs: object) -> httpx.Response:
        captured["path"] = path
        return httpx.Response(
            200,
            request=httpx.Request("GET", f"https://example.test{path}"),
            json={"messages": []},
        )

    client = ThinTurnConversationClient(
        tenant_id="anthus",
        user_id="ryan",
        base_url="https://example.test",
    )
    client._client.get = fake_get  # type: ignore[method-assign]
    messages = client.list_channel_messages("chan-1", after_seq=3)
    assert messages == []
    assert captured["path"] == org_path("anthus", "/channels/chan-1/messages")
