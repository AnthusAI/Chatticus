"""Tests for per-worker bearer credentials."""

from __future__ import annotations

import logging

import boto3
import pytest
from cognito_test_support import make_cognito_test_keys
from fastapi.testclient import TestClient
from moto import mock_aws

from chatticus.control_plane import ControlPlane
from chatticus.http.app import INVOKE_HEADER, create_app
from chatticus.http.paths import org_path
from chatticus.http.principal import (
    PrincipalAudience,
    PrincipalAudienceDeniedError,
    verify_principal_audience,
)
from chatticus.messaging.store import DynamoMessagingStore, create_messaging_table
from chatticus.models import CostClass, WorkerRegistration
from chatticus.principal import Principal, PrincipalKind
from chatticus.worker_credentials import (
    hash_worker_token,
    mint_worker_token,
    verify_worker_token_hash,
)


def _worker_registration(worker_id: str = "worker-1") -> WorkerRegistration:
    return WorkerRegistration(
        worker_id=worker_id,
        tenant_id="anthus",
        cost_class=CostClass.LOCAL,
        capabilities=frozenset({"cpu"}),
    )


def test_register_worker_mints_token_and_stores_hash() -> None:
    plane = ControlPlane()
    token = plane.register_worker(_worker_registration())
    record = plane.worker("anthus", "worker-1")
    assert verify_worker_token_hash(token, record.token_hash)
    assert plane.verify_worker_token("anthus", token) == "worker-1"


def test_re_register_rotates_token() -> None:
    plane = ControlPlane()
    first = plane.register_worker(_worker_registration())
    second = plane.register_worker(_worker_registration())
    assert first != second
    assert plane.verify_worker_token("anthus", first) is None
    assert plane.verify_worker_token("anthus", second) == "worker-1"


def test_worker_route_requires_bearer() -> None:
    plane = ControlPlane()
    client = TestClient(create_app(plane, invoke_key=""))
    response = client.post(
        org_path("anthus", "/turns/missing/claim"),
        json={"worker_id": "worker-1"},
    )
    assert response.status_code == 403


def test_invoke_key_does_not_satisfy_worker_route() -> None:
    plane = ControlPlane()
    client = TestClient(create_app(plane, invoke_key="edge-secret"))
    response = client.post(
        org_path("anthus", "/turns/missing/claim"),
        json={"worker_id": "worker-1"},
        headers={INVOKE_HEADER: "edge-secret"},
    )
    assert response.status_code == 403


def test_browser_route_rejects_worker_bearer() -> None:
    plane = ControlPlane()
    token = plane.register_worker(_worker_registration())
    keys = make_cognito_test_keys()
    client = TestClient(
        create_app(plane, invoke_key="", cognito_verifier=keys.verifier())
    )
    response = client.post(
        org_path("anthus", "/channels"),
        json={"user_id": "ryan", "bot_ids": []},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 403


def test_browser_route_requires_user_credential() -> None:
    plane = ControlPlane()
    keys = make_cognito_test_keys()
    client = TestClient(
        create_app(plane, invoke_key="", cognito_verifier=keys.verifier())
    )
    response = client.post(
        org_path("anthus", "/bots"),
        json={"user_id": "ryan", "name": "Helper"},
    )
    assert response.status_code == 403


def test_worker_claim_requires_matching_worker_id() -> None:
    plane = ControlPlane()
    token = plane.register_worker(_worker_registration("worker-a"))
    client = TestClient(create_app(plane, invoke_key=""))
    response = client.post(
        org_path("anthus", "/turns/missing/claim"),
        json={"worker_id": "worker-b"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 403


def test_registration_never_logs_plaintext_token(
    caplog: pytest.LogCaptureFixture,
) -> None:
    plane = ControlPlane()
    client = TestClient(create_app(plane, invoke_key=""))
    with caplog.at_level(logging.INFO):
        response = client.post(
            org_path("anthus", "/workers/register"),
            json={
                "worker_id": "log-probe-worker",
                "cost_class": "local",
                "capabilities": ["cpu"],
            },
        )
    assert response.status_code == 200
    token = response.json()["token"]
    for record in caplog.records:
        assert token not in record.getMessage()


def test_verify_principal_audience_rejects_user_on_worker_route() -> None:
    principal = Principal(
        kind=PrincipalKind.USER,
        tenant_id="anthus",
        user_id="ryan",
    )
    with pytest.raises(PrincipalAudienceDeniedError):
        verify_principal_audience(principal, audience=PrincipalAudience.WORKER)


def test_hash_worker_token_is_deterministic() -> None:
    token = mint_worker_token()
    assert hash_worker_token(token) == hash_worker_token(token)


def test_worker_credential_survives_recycled_control_plane() -> None:
    plane = ControlPlane()
    token = plane.register_worker(_worker_registration())
    recycled = ControlPlane(messaging_store=plane._messaging_store)
    assert recycled.verify_worker_token("anthus", token) == "worker-1"


def test_worker_credential_persists_in_dynamo_across_recycled_plane() -> None:
    with mock_aws():
        client = boto3.client("dynamodb", region_name="us-east-1")
        table_name = "chatticus-worker-credential-test"
        create_messaging_table(client, table_name)
        store = DynamoMessagingStore(table_name, client=client)
        first = ControlPlane(messaging_store=store)
        token = first.register_worker(_worker_registration())
        second = ControlPlane(messaging_store=store)
        assert second.verify_worker_token("anthus", token) == "worker-1"
        stored = store.get_worker("anthus", "worker-1")
        assert stored is not None
        assert stored.token_hash == hash_worker_token(token)
        assert "token" not in client.get_item(
            TableName=table_name,
            Key={
                "pk": {"S": "anthus#roster"},
                "sk": {"S": "worker#worker-1"},
            },
        ).get("Item", {})
