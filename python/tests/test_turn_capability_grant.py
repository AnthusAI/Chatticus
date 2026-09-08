"""Durable task-grant persistence across recycled control planes."""

from __future__ import annotations

import boto3
import pytest
from grant_fixtures import research_grant
from moto import mock_aws

from chatticus.capability_sinks import CapabilitySinkDenied
from chatticus.control_plane import ControlPlane
from chatticus.messaging.store import DynamoMessagingStore, create_messaging_table


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
