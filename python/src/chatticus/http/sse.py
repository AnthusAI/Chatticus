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
    return payload


def format_turn_event_sse(event: TurnEvent) -> str:
    """Format one turn event as an SSE frame with event type and JSON data."""
    payload = turn_event_payload(event)
    data = json.dumps(payload, separators=(",", ":"))
    return f"event: {event.kind}\ndata: {data}\n\n"
