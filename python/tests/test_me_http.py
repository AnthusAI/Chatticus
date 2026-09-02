"""Tests for GET /me membership snapshot."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from cognito_test_support import make_cognito_test_keys, mint_id_token
from fastapi.testclient import TestClient

from chatticus.control_plane import ControlPlane
from chatticus.http.app import create_app
from chatticus.http.principal import resolve_me_from_token
from chatticus.org_records import ANTHUS_TENANT_ID

NOW = datetime(2026, 8, 31, 12, 0, 0, tzinfo=UTC)


@pytest.fixture
def keys() -> object:
    return make_cognito_test_keys()


@pytest.fixture
def client(keys: object) -> TestClient:
    plane = ControlPlane()
    app = create_app(plane, invoke_key="", cognito_verifier=keys.verifier())
    return TestClient(app)


def test_get_me_without_authorization_fails_closed(client: TestClient) -> None:
    response = client.get("/me")
    assert response.status_code == 403


def test_get_me_with_invalid_token_fails_closed(client: TestClient) -> None:
    response = client.get("/me", headers={"Authorization": "Bearer not-a-jwt"})
    assert response.status_code == 403


def test_get_me_unknown_email_returns_empty_membership(
    client: TestClient, keys: object
) -> None:
    token = mint_id_token(keys, email="unknown@example.com")
    response = client.get("/me", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["email"] == "unknown@example.com"
    assert payload["user_id"] is None
    assert payload["organizations"] == []


def test_get_me_signed_in_without_orgs(keys: object) -> None:
    plane = ControlPlane()
    plane.sign_in("sam@example.com", now=NOW)
    token = mint_id_token(keys, email="sam@example.com")
    me = resolve_me_from_token(plane, token, verifier=keys.verifier())
    assert me.email == "sam@example.com"
    assert me.user_id is not None
    assert me.organizations == ()


def test_get_me_returns_pending_organization(keys: object) -> None:
    plane = ControlPlane()
    owner = plane.sign_in("ryan@example.com", now=NOW)
    plane.create_organization(owner, "Anthus Labs", now=NOW)
    token = mint_id_token(keys, email="ryan@example.com")
    me = resolve_me_from_token(plane, token, verifier=keys.verifier())
    assert len(me.organizations) == 1
    assert me.organizations[0].status.value == "pending"


def test_get_me_returns_enabled_organization(keys: object, client: TestClient) -> None:
    plane = client.app.state.chatticus.plane
    plane.admin_seed_organization(
        ANTHUS_TENANT_ID,
        "owner@example.com",
        name="Anthus",
        now=NOW,
    )
    token = mint_id_token(keys, email="owner@example.com")
    response = client.get("/me", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["email"] == "owner@example.com"
    assert payload["organizations"] == [{"tenant_id": "anthus", "status": "enabled"}]


def test_get_me_without_verifier_returns_service_unavailable() -> None:
    client = TestClient(create_app(ControlPlane(), invoke_key=""))
    response = client.get("/me", headers={"Authorization": "Bearer token"})
    assert response.status_code == 503
