"""Tests for worker bearer registration helpers."""

from __future__ import annotations

from chatticus.control_plane import ControlPlane
from chatticus.http.app import create_app
from chatticus.http.paths import org_path
from chatticus.http.test_server import start_test_server
from chatticus.http.worker_auth import register_worker_bearer


def test_register_worker_bearer_mints_authorization_header() -> None:
    plane = ControlPlane()
    api = start_test_server(create_app(plane, invoke_key=""))
    headers = register_worker_bearer(api, "anthus", "garage-mac-1")
    assert headers["Authorization"].startswith("Bearer ")
    claim = api.post(
        org_path("anthus", "/turns/missing/claim"),
        json={"worker_id": "garage-mac-1"},
        headers=headers,
    )
    assert claim.status_code == 404
