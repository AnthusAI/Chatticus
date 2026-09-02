"""Parse turn SSE frames from the thin-turn front door."""

from __future__ import annotations

import json


def parse_sse_frames(buffer: str) -> tuple[list[dict], str]:
    """Return parsed SSE data events and the remaining buffer."""
    events: list[dict] = []
    while "\n\n" in buffer:
        frame, buffer = buffer.split("\n\n", 1)
        for line in frame.split("\n"):
            if line.startswith("data:"):
                events.append(json.loads(line[5:].strip()))
    return events, buffer
