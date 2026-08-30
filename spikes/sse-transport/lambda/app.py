"""Throwaway SSE spike for Lambda response streaming feasibility."""

from __future__ import annotations

import json
import os
import time
from typing import Generator

from flask import Flask, Response, request

DEFAULT_DURATION_SECONDS = 1200
EMIT_INTERVAL_SECONDS = 0.25

app = Flask(__name__)


def parse_start_sequence(last_event_id: str | None) -> int:
    """Return the next sequence number after ``last_event_id``."""
    if not last_event_id:
        return 0
    return int(last_event_id) + 1


def parse_duration_seconds() -> int:
    """Read an optional ``duration`` query parameter in seconds."""
    raw_duration = request.args.get("duration")
    if raw_duration is None:
        return DEFAULT_DURATION_SECONDS
    return max(1, int(raw_duration))


def parse_max_frames() -> int | None:
    """Read an optional ``max_frames`` query parameter."""
    raw_max_frames = request.args.get("max_frames")
    if raw_max_frames is None:
        return None
    return max(1, int(raw_max_frames))


def sse_frame(sequence: int, server_unix_ms: int) -> str:
    """Format one server-sent event frame with a monotonic id."""
    payload = json.dumps({"seq": sequence, "server_unix_ms": server_unix_ms})
    return f"id: {sequence}\ndata: {payload}\n\n"


def event_stream(
    start_sequence: int,
    duration_seconds: int,
    max_frames: int | None,
) -> Generator[str, None, None]:
    """Yield numbered SSE frames every 250 milliseconds."""
    sequence = start_sequence
    frames_emitted = 0
    started_at = time.monotonic()
    while time.monotonic() - started_at < duration_seconds:
        server_unix_ms = int(time.time() * 1000)
        yield sse_frame(sequence, server_unix_ms)
        sequence += 1
        frames_emitted += 1
        if max_frames is not None and frames_emitted >= max_frames:
            return
        time.sleep(EMIT_INTERVAL_SECONDS)


@app.route("/stream", methods=["GET", "OPTIONS"])
def stream() -> Response:
    """Stream synthetic SSE frames for transport measurement."""
    if request.method == "OPTIONS":
        return Response(status=204)

    start_sequence = parse_start_sequence(request.headers.get("Last-Event-ID"))
    duration_seconds = parse_duration_seconds()
    max_frames = parse_max_frames()

    return Response(
        event_stream(start_sequence, duration_seconds, max_frames),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-store",
            "X-Accel-Buffering": "no",
        },
    )


@app.route("/health", methods=["GET"])
def health() -> Response:
    """Simple readiness probe for deploy smoke checks."""
    return Response("ok\n", mimetype="text/plain")


if __name__ == "__main__":
    port = int(os.environ.get("AWS_LWA_PORT", "8080"))
    from waitress import serve

    serve(app, host="0.0.0.0", port=port, threads=8, channel_timeout=900)
