"""Pytest configuration for Chatticus kernel tests."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from chatticus.control_plane import ControlPlane
from chatticus.http.app import create_app
from chatticus.http.test_server import start_test_server
from chatticus.http.worker_auth import register_worker_bearer

_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))


@pytest.fixture(autouse=True)
def _clear_invoke_key_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CHATTICUS_INVOKE_KEY", raising=False)


def make_test_api(plane: ControlPlane | None = None) -> tuple[ControlPlane, object]:
    """Return a control plane and in-process HTTP client without invoke-key gating."""
    resolved_plane = plane or ControlPlane()
    api = start_test_server(create_app(resolved_plane, invoke_key=""))
    return resolved_plane, api


def register_worker_headers(
    api: object,
    tenant_id: str,
    worker_id: str = "test-worker",
) -> dict[str, str]:
    """Register one worker and return Authorization headers for worker routes."""
    return register_worker_bearer(api, tenant_id, worker_id)
