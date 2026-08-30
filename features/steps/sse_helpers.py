"""Helpers for reading turn-scoped server-sent event streams in behave."""

from __future__ import annotations

import json
import threading
import time
from typing import Any


def tenant_headers(tenant_id: str) -> dict[str, str]:
    """Return authenticated tenant headers for the front door."""
    return {"X-Tenant-Id": tenant_id}


def parse_sse_frames(buffer: str) -> list[dict[str, Any]]:
    """Parse complete SSE frames from a text buffer."""
    events: list[dict[str, Any]] = []
    for frame in buffer.split("\n\n"):
        stripped = frame.strip()
        if not stripped:
            continue
        data_line = next(
            (line for line in stripped.split("\n") if line.startswith("data:")),
            None,
        )
        if data_line is None:
            continue
        events.append(json.loads(data_line[5:].strip()))
    return events


class SseWatcher:
    """Background reader for GET /turns/{turn_id}/stream."""

    def __init__(
        self,
        client: object,
        turn_id: str,
        tenant_id: str,
        after_seq: int = 0,
    ) -> None:
        self.client = client
        self.turn_id = turn_id
        self.tenant_id = tenant_id
        self.after_seq = after_seq
        self.events: list[dict[str, Any]] = []
        self.closed = False
        self._stop = False
        self._thread: threading.Thread | None = None
        self._response: object | None = None

    def start(self) -> None:
        """Start reading the stream in a background thread."""

        def run() -> None:
            try:
                with self.client.stream(
                    "GET",
                    f"/turns/{self.turn_id}/stream",
                    headers=tenant_headers(self.tenant_id),
                    params={"after_seq": self.after_seq},
                ) as response:
                    self._response = response
                    if response.status_code != 200:
                        self.closed = True
                        return
                    buffer = ""
                    for chunk in response.iter_bytes():
                        if self._stop:
                            break
                        buffer += chunk.decode()
                        while "\n\n" in buffer:
                            frame, buffer = buffer.split("\n\n", 1)
                            for event in parse_sse_frames(frame + "\n\n"):
                                self.events.append(event)
                                if event.get("kind") == "turn.completed":
                                    self.closed = True
                                    return
            finally:
                self.closed = True

        self._thread = threading.Thread(target=run, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        """Close the stream without completing the turn."""
        self._stop = True
        if self._response is not None:
            self._response.close()
        self.closed = True

    def wait_for_events(
        self,
        count: int,
        *,
        timeout: float = 2.0,
    ) -> None:
        """Block until at least count events arrive or timeout."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if len(self.events) >= count:
                return
            time.sleep(0.01)
        raise AssertionError(
            f"Expected {count} SSE events, got {len(self.events)}: {self.events}"
        )

    def wait_for_kind(self, kind: str, *, timeout: float = 5.0) -> None:
        """Block until an event of the given kind arrives or timeout."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if any(event.get("kind") == kind for event in self.events):
                return
            time.sleep(0.01)
        raise AssertionError(f"Expected an SSE event kind {kind!r}, got {self.events}")


def read_sse_until(
    client: object,
    turn_id: str,
    tenant_id: str,
    after_seq: int = 0,
    *,
    min_events: int = 1,
    timeout: float = 2.0,
) -> list[dict[str, Any]]:
    """Read a turn stream synchronously until min_events or timeout."""
    events: list[dict[str, Any]] = []
    deadline = time.monotonic() + timeout
    with client.stream(
        "GET",
        f"/turns/{turn_id}/stream",
        headers=tenant_headers(tenant_id),
        params={"after_seq": after_seq},
    ) as response:
        if response.status_code != 200:
            return events
        buffer = ""
        for chunk in response.iter_bytes():
            if time.monotonic() > deadline:
                break
            buffer += chunk.decode()
            while "\n\n" in buffer:
                frame, buffer = buffer.split("\n\n", 1)
                events.extend(parse_sse_frames(frame + "\n\n"))
            if len(events) >= min_events:
                response.close()
                break
    return events
