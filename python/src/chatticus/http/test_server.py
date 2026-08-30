"""In-process HTTP server for behave and pytest SSE tests."""

from __future__ import annotations

import socket
import threading
import time
from typing import Any

import httpx
import uvicorn


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def start_test_server(app: Any, port: int | None = None) -> httpx.Client:
    """Run the FastAPI app on a local port and return an HTTP client."""
    chosen_port = port if port is not None else _free_port()
    config = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=chosen_port,
        log_level="error",
        lifespan="on",
    )
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    client = httpx.Client(base_url=f"http://127.0.0.1:{chosen_port}", timeout=30.0)
    for _ in range(100):
        try:
            client.get("/docs")
            return client
        except httpx.ConnectError:
            time.sleep(0.05)
    raise RuntimeError("test HTTP server failed to start")
