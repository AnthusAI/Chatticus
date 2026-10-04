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


SERVER_SHUTDOWN_JOIN_SECONDS = 10.0


class LocalServerClient(httpx.Client):
    """HTTP client that owns the local server it talks to and stops it on close."""

    def attach_server(self, server: uvicorn.Server, thread: threading.Thread) -> None:
        """Remember the server thread so close can stop it."""
        self._server = server
        self._server_thread = thread

    def close(self) -> None:
        """Close the client, then stop the server and wait for its thread."""
        super().close()
        server = getattr(self, "_server", None)
        thread = getattr(self, "_server_thread", None)
        if server is None or thread is None:
            return
        self._server = None
        self._server_thread = None
        server.should_exit = True
        thread.join(timeout=SERVER_SHUTDOWN_JOIN_SECONDS)


def start_test_server(app: Any, port: int | None = None) -> LocalServerClient:
    """Run the FastAPI app on a local port and return a client that stops it."""
    chosen_port = port if port is not None else _free_port()
    config = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=chosen_port,
        log_level="error",
        lifespan="on",
        timeout_graceful_shutdown=1,
    )
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    client = LocalServerClient(base_url=f"http://127.0.0.1:{chosen_port}", timeout=30.0)
    client.attach_server(server, thread)
    for _ in range(100):
        try:
            client.get("/docs")
            return client
        except httpx.ConnectError:
            time.sleep(0.05)
    client.close()
    raise RuntimeError("test HTTP server failed to start")
