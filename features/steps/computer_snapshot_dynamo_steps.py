"""Step definitions for Dynamo-backed computer snapshot metadata durability."""

from __future__ import annotations

import hashlib
import json
from uuid import uuid4

import boto3
from behave import given, then
from moto import mock_aws

from chatticus.control_plane import ControlPlane
from chatticus.messaging.store import DynamoMessagingStore, create_messaging_table


def _disk_checksum(workspace: dict[str, str], browser_sessions: dict[str, str]) -> str:
    payload = json.dumps(
        {"workspace": workspace, "browser_sessions": browser_sessions},
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode()).hexdigest()


def _stored_computer(context: object, tenant_id: str, computer_id: str):
    computer = context.plane.computer_for_organization(tenant_id)
    assert computer.computer_id == computer_id
    return computer


@given("an empty control plane backed by a Dynamo messaging store")
def given_dynamo_messaging_store(context: object) -> None:
    context._moto = mock_aws()
    context._moto.start()
    table_name = f"chatticus-computer-snapshot-dynamo-{uuid4()}"
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_messaging_table(client, table_name)
    context.messaging_store = DynamoMessagingStore(table_name, client=client)
    context.plane = ControlPlane(messaging_store=context.messaging_store)
    context.bots_by_name = {}


@then('tenant "{tenant_id}" computer "{computer_id}" has snapshot URI "{snapshot_uri}"')
def then_tenant_computer_snapshot_uri(
    context: object, tenant_id: str, computer_id: str, snapshot_uri: str
) -> None:
    computer = _stored_computer(context, tenant_id, computer_id)
    assert computer.snapshot_uri == snapshot_uri


@then(
    'tenant "{tenant_id}" computer "{computer_id}" has snapshot generation '
    "{generation:d}"
)
def then_tenant_computer_snapshot_generation(
    context: object, tenant_id: str, computer_id: str, generation: int
) -> None:
    computer = _stored_computer(context, tenant_id, computer_id)
    assert computer.snapshot_generation == generation


@then(
    'tenant "{tenant_id}" computer "{computer_id}" has snapshot checksum for file '
    '"{path}" as "{content}"'
)
def then_tenant_computer_snapshot_checksum(
    context: object, tenant_id: str, computer_id: str, path: str, content: str
) -> None:
    computer = _stored_computer(context, tenant_id, computer_id)
    expected = _disk_checksum({path: content}, {})
    assert computer.snapshot_checksum == expected


@then('tenant "{tenant_id}" computer "{computer_id}" is not dirty on the store')
def then_tenant_computer_not_dirty_on_store(
    context: object, tenant_id: str, computer_id: str
) -> None:
    computer = _stored_computer(context, tenant_id, computer_id)
    assert computer.disk_dirty is False


@then('tenant "{tenant_id}" computer "{computer_id}" is dirty on the store')
def then_tenant_computer_dirty_on_store(
    context: object, tenant_id: str, computer_id: str
) -> None:
    computer = _stored_computer(context, tenant_id, computer_id)
    assert computer.disk_dirty is True


@then(
    'tenant "{tenant_id}" computer "{computer_id}" requires hydrate on worker '
    '"{worker_id}"'
)
def then_tenant_computer_requires_hydrate_on_worker(
    context: object, tenant_id: str, computer_id: str, worker_id: str
) -> None:
    computer = _stored_computer(context, tenant_id, computer_id)
    assert computer.hydrate_required is True
    assert computer.intended_host_worker_id == worker_id
