"""Durable task-grant persistence across recycled control planes."""

from __future__ import annotations

import boto3
import pytest
from grant_fixtures import research_grant
from moto import mock_aws

from chatticus.capability_sinks import CapabilitySinkDenied
from chatticus.control_plane import ControlPlane
from chatticus.http.app import create_app
from chatticus.http.paths import org_path
from chatticus.http.test_server import start_test_server
from chatticus.messaging.store import DynamoMessagingStore, create_messaging_table
from chatticus.models import ActorKind
from conftest import register_worker_headers


def test_grant_persists_across_recycled_control_plane() -> None:
    with mock_aws():
        client = boto3.client("dynamodb", region_name="us-east-1")
        table_name = "chatticus-messaging"
        create_messaging_table(client, table_name)
        store = DynamoMessagingStore(table_name, client=client)
        first = ControlPlane(messaging_store=store)
        first.set_turn_capability_grant("anthus", "turn-1", research_grant())
        second = ControlPlane(messaging_store=store)
        with pytest.raises(CapabilitySinkDenied):
            second.gated_read_workspace(
                "anthus",
                "turn-1",
                "/workspace/secrets/notes.txt",
            )


def test_grant_allow_path_survives_recycled_plane() -> None:
    with mock_aws():
        client = boto3.client("dynamodb", region_name="us-east-1")
        table_name = "chatticus-messaging"
        create_messaging_table(client, table_name)
        store = DynamoMessagingStore(table_name, client=client)
        first = ControlPlane(messaging_store=store)
        first.set_turn_capability_grant("anthus", "turn-1", research_grant())
        second = ControlPlane(messaging_store=store)
        second.gated_read_workspace(
            "anthus",
            "turn-1",
            "/workspace/research/notes.txt",
        )


def test_http_grant_persists_without_workspace_execute_route() -> None:
    with mock_aws():
        client = boto3.client("dynamodb", region_name="us-east-1")
        table_name = "chatticus-messaging"
        create_messaging_table(client, table_name)
        store = DynamoMessagingStore(table_name, client=client)
        plane = ControlPlane(messaging_store=store)
        bot = plane.create_bot("anthus", "Researcher", creator_user_id="ryan")
        channel = plane.create_channel("anthus", "ryan", [bot.bot_id])
        _, turn = plane.post_channel_message(
            channel.channel_id,
            "anthus",
            ActorKind.HUMAN,
            "ryan",
            "grant probe",
            addressed_to_bot_id=bot.bot_id,
            enqueue_turn=False,
        )
        assert turn is not None
        api = start_test_server(create_app(plane, invoke_key=""))
        worker_headers = register_worker_headers(api, "anthus")
        grant = api.put(
            org_path("anthus", f"/turns/{turn.turn_id}/grant"),
            json={
                "tools": ["browse", "read_workspace"],
                "origins": ["https://docs.example.com"],
                "recipients": [],
                "file_scopes": ["/workspace/research"],
                "egress_classes": ["approved_origin_fetch"],
            },
            headers=worker_headers,
        )
        assert grant.status_code == 200
        api.close()
        recycled = ControlPlane(messaging_store=store)
        recycled.gated_read_workspace(
            "anthus",
            turn.turn_id,
            "/workspace/research/notes.txt",
        )
