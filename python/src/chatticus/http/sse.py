"""Server-sent event framing for turn-scoped streams."""

from __future__ import annotations

import json
from typing import Any

from chatticus.models import TurnEvent


def turn_event_payload(event: TurnEvent) -> dict[str, Any]:
    """Serialize one durable turn event for an SSE data frame."""
    payload: dict[str, Any] = {
        "kind": event.kind,
        "seq": event.seq,
        "event_id": event.event_id,
        "turn_id": event.turn_id,
        "channel_id": event.channel_id,
    }
    if event.token is not None:
        payload["token"] = event.token
    if event.message_seq is not None:
        payload["message_seq"] = event.message_seq
    if event.body is not None:
        payload["body"] = event.body
    if event.pending_computer_tool is not None:
        pending = event.pending_computer_tool
        payload["pending_computer_tool"] = {
            "action_id": pending.action_id,
            "tool_name": pending.tool_name,
            "arguments": dict(pending.arguments),
        }
    if event.action_id is not None:
        payload["action_id"] = event.action_id
    if event.attempt_id is not None:
        payload["attempt_id"] = event.attempt_id
    return payload


def cursor_from_last_event_id(last_event_id: str | None) -> int:
    """Return the exclusive seq cursor encoded by an SSE ``Last-Event-ID``.

    Missing or empty means the client has seen nothing. A numeric value is
    the last durable ``seq`` the client already has, so replay starts after
    it. Non-numeric values are rejected.

    :raises ValueError: If the header is present and not a decimal integer.
    """
    if last_event_id is None:
        return 0
    stripped = last_event_id.strip()
    if stripped == "":
        return 0
    if not stripped.isdigit():
        raise ValueError(f"Last-Event-ID {last_event_id!r} is not a sequence.")
    return int(stripped)


def format_turn_event_sse(event: TurnEvent) -> str:
    """Format one turn event as an SSE frame with ``id`` equal to ``seq``."""
    payload = turn_event_payload(event)
    data = json.dumps(payload, separators=(",", ":"))
    return f"event: {event.kind}\nid: {event.seq}\ndata: {data}\n\n"
