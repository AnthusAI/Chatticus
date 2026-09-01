"""Tests for the members administrator CLI and store list-by-status."""

from __future__ import annotations

import io
from datetime import UTC, datetime

import boto3
import pytest
from moto import mock_aws

from chatticus.control_plane import ControlPlane
from chatticus.members.__main__ import main as members_main
from chatticus.messaging.store import (
    DynamoMessagingStore,
    InMemoryMessagingStore,
    create_messaging_table,
)
from chatticus.models import (
    LastOwnerCannotBeDemotedError,
    MemberRole,
    OrganizationStatus,
    OrganizationStatusTransitionError,
)
from chatticus.org_records import OrgRecordsKernel

NOW = datetime(2026, 8, 31, 12, 0, 0, tzinfo=UTC)


def _seed_pending_org(store: InMemoryMessagingStore) -> tuple[str, str]:
    kernel = OrgRecordsKernel(store)
    owner = kernel.sign_in("ryan@example.com", now=NOW)
    org = kernel.create_organization(owner, "Anthus Labs", now=NOW)
    return org.tenant_id, owner.user_id


def test_list_organizations_by_status_in_memory() -> None:
    store = InMemoryMessagingStore()
    tenant_id, _owner_id = _seed_pending_org(store)
    kernel = OrgRecordsKernel(store)
    pending = kernel.list_organizations_by_status(OrganizationStatus.PENDING)
    assert [org.tenant_id for org in pending] == [tenant_id]
    assert kernel.list_organizations_by_status(OrganizationStatus.ENABLED) == []


@mock_aws
def test_list_organizations_by_status_dynamo() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    table_name = "MessagingMembersCli"
    create_messaging_table(client, table_name)
    store = DynamoMessagingStore(table_name, client=client)
    tenant_id, _owner_id = _seed_pending_org(store)
    recycled = OrgRecordsKernel(DynamoMessagingStore(table_name, client=client))
    pending = recycled.list_organizations_by_status(OrganizationStatus.PENDING)
    assert [org.tenant_id for org in pending] == [tenant_id]


def test_members_cli_list_and_enable_without_computer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = InMemoryMessagingStore()
    tenant_id, owner_id = _seed_pending_org(store)
    plane = ControlPlane(messaging_store=store)

    monkeypatch.setattr("sys.stdin", io.StringIO(""))
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)

    listed = members_main(["list", "--status", "pending"], plane_factory=lambda: plane)
    assert listed == 0

    enabled = members_main(["enable", tenant_id, "--yes"], plane_factory=lambda: plane)
    assert enabled == 0

    organization = plane.get_organization(tenant_id)
    assert organization.status == OrganizationStatus.ENABLED
    assert plane._messaging_store.get_computer(tenant_id, owner_id) is None


def test_members_cli_enable_requires_pending(monkeypatch: pytest.MonkeyPatch) -> None:
    store = InMemoryMessagingStore()
    tenant_id, _owner_id = _seed_pending_org(store)
    plane = ControlPlane(messaging_store=store)
    plane.enable_organization(tenant_id)

    monkeypatch.setattr("sys.stdin", io.StringIO(""))
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)

    result = members_main(["enable", tenant_id, "--yes"], plane_factory=lambda: plane)
    assert result == 1


def test_members_cli_suspend_requires_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    store = InMemoryMessagingStore()
    tenant_id, _owner_id = _seed_pending_org(store)
    plane = ControlPlane(messaging_store=store)

    monkeypatch.setattr("sys.stdin", io.StringIO(""))
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)

    result = members_main(["suspend", tenant_id, "--yes"], plane_factory=lambda: plane)
    assert result == 1


def test_members_cli_mutations_require_yes_when_not_tty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = InMemoryMessagingStore()
    tenant_id, owner_id = _seed_pending_org(store)
    plane = ControlPlane(messaging_store=store)

    monkeypatch.setattr("sys.stdin", io.StringIO(""))
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)

    assert members_main(["enable", tenant_id], plane_factory=lambda: plane) == 2


def test_enable_organization_requires_pending_status() -> None:
    store = InMemoryMessagingStore()
    tenant_id, _owner_id = _seed_pending_org(store)
    kernel = OrgRecordsKernel(store)
    kernel.enable_organization(tenant_id)
    with pytest.raises(OrganizationStatusTransitionError):
        kernel.enable_organization(tenant_id)


def test_suspend_organization_requires_enabled_status() -> None:
    store = InMemoryMessagingStore()
    tenant_id, _owner_id = _seed_pending_org(store)
    kernel = OrgRecordsKernel(store)
    with pytest.raises(OrganizationStatusTransitionError):
        kernel.suspend_organization(tenant_id)


def test_admin_set_member_role_blocks_last_owner_demotion() -> None:
    store = InMemoryMessagingStore()
    tenant_id, owner_id = _seed_pending_org(store)
    plane = ControlPlane(messaging_store=store)
    with pytest.raises(LastOwnerCannotBeDemotedError):
        plane.admin_set_member_role(tenant_id, owner_id, MemberRole.MEMBER)
