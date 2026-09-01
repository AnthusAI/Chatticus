"""Unit tests for org-scoped HTTP paths and header rejection."""

from __future__ import annotations

from fastapi.testclient import TestClient

from chatticus.control_plane import ControlPlane
from chatticus.http.app import create_app
from chatticus.http.paths import org_path


def test_org_path_prefixes_tenant() -> None:
    assert org_path("anthus", "/channels") == "/orgs/anthus/channels"
    assert org_path("anthus", "channels") == "/orgs/anthus/channels"


def test_front_door_rejects_x_tenant_id_header() -> None:
    plane = ControlPlane()
    client = TestClient(create_app(plane))
    response = client.get(
        org_path("anthus", "/users/ryan/bots"),
        headers={"X-Tenant-Id": "anthus"},
    )
    assert response.status_code == 400
    assert "X-Tenant-Id" in response.json()["detail"]


def test_health_allows_requests_without_org_prefix() -> None:
    plane = ControlPlane()
    client = TestClient(create_app(plane))
    response = client.get("/health")
    assert response.status_code == 200
