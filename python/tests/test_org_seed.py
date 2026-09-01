"""Tests for first organization seed and cold bootstrap paths."""

from __future__ import annotations

import io
from datetime import UTC, datetime

import pytest

from chatticus.control_plane import ControlPlane
from chatticus.members.__main__ import main as members_main
from chatticus.messaging.store import InMemoryMessagingStore
from chatticus.models import (
    Bot,
    IdentityUserIdMismatchError,
    MemberRole,
    OrganizationStatus,
    OrganizationStatusTransitionError,
)
from chatticus.org_records import (
    ANTHUS_LEGACY_USER_ID,
    ANTHUS_TENANT_ID,
    OrgRecordsKernel,
)

NOW = datetime(2026, 8, 31, 12, 0, 0, tzinfo=UTC)


def test_admin_seed_anthus_creates_enabled_org_with_legacy_user_id() -> None:
    store = InMemoryMessagingStore()
    store.put_bot(
        Bot(
            bot_id="bot-1",
            tenant_id=ANTHUS_TENANT_ID,
            user_id=ANTHUS_LEGACY_USER_ID,
            name="Researcher",
        ),
        reserve_name=True,
    )
    plane = ControlPlane(messaging_store=store)

    organization = plane.admin_seed_anthus_organization(
        "owner@example.com",
        name="Anthus",
        now=NOW,
    )

    assert organization.tenant_id == ANTHUS_TENANT_ID
    assert organization.status == OrganizationStatus.ENABLED
    identity = store.get_identity_by_email("owner@example.com")
    assert identity is not None
    assert identity.user_id == ANTHUS_LEGACY_USER_ID
    membership = store.get_membership(ANTHUS_TENANT_ID, ANTHUS_LEGACY_USER_ID)
    assert membership is not None
    assert membership.role == MemberRole.OWNER
    assert store.get_computer(ANTHUS_TENANT_ID, ANTHUS_LEGACY_USER_ID) is None
    loaded = store.get_bot(ANTHUS_TENANT_ID, "bot-1")
    assert loaded is not None
    assert loaded.name == "Researcher"


def test_admin_seed_anthus_is_idempotent() -> None:
    store = InMemoryMessagingStore()
    kernel = OrgRecordsKernel(store)
    first = kernel.admin_seed_anthus_organization(
        "owner@example.com",
        name="Anthus",
        now=NOW,
    )
    second = kernel.admin_seed_anthus_organization(
        "owner@example.com",
        name="Anthus",
        now=NOW,
    )
    assert second == first
    assert len(kernel.list_organizations_by_status(OrganizationStatus.ENABLED)) == 1


def test_admin_seed_anthus_enables_pending_org() -> None:
    store = InMemoryMessagingStore()
    kernel = OrgRecordsKernel(store)
    owner = kernel._admin_ensure_anthus_owner_identity("owner@example.com", now=NOW)
    kernel._put_pending_organization(
        owner,
        "Anthus",
        tenant_id=ANTHUS_TENANT_ID,
        now=NOW,
    )

    organization = kernel.admin_seed_anthus_organization(
        "owner@example.com",
        name="Anthus",
        now=NOW,
    )

    assert organization.status == OrganizationStatus.ENABLED


def test_admin_seed_anthus_rejects_conflicting_identity_user_id() -> None:
    store = InMemoryMessagingStore()
    kernel = OrgRecordsKernel(store)
    kernel.sign_in("owner@example.com", now=NOW)

    with pytest.raises(IdentityUserIdMismatchError):
        kernel.admin_seed_anthus_organization(
            "owner@example.com",
            name="Anthus",
            now=NOW,
        )


def test_members_cli_create_then_enable_without_computer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = InMemoryMessagingStore()
    plane = ControlPlane(messaging_store=store)
    monkeypatch.setattr("sys.stdin", io.StringIO(""))
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)

    created = members_main(
        [
            "create",
            "--owner-email",
            "owner@example.com",
            "--name",
            "Bootstrap Labs",
            "--yes",
        ],
        plane_factory=lambda: plane,
    )
    assert created == 0

    pending = plane.list_organizations_by_status(OrganizationStatus.PENDING)
    assert len(pending) == 1
    tenant_id = pending[0].tenant_id

    enabled = members_main(["enable", tenant_id, "--yes"], plane_factory=lambda: plane)
    assert enabled == 0

    organization = plane.get_organization(tenant_id)
    assert organization.status == OrganizationStatus.ENABLED
    owner_id = organization.owner_user_id
    assert plane._messaging_store.get_computer(tenant_id, owner_id) is None


def test_members_cli_seed_anthus_without_computer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = InMemoryMessagingStore()
    store.put_bot(
        Bot(
            bot_id="bot-1",
            tenant_id=ANTHUS_TENANT_ID,
            user_id=ANTHUS_LEGACY_USER_ID,
            name="Researcher",
        ),
        reserve_name=True,
    )
    plane = ControlPlane(messaging_store=store)
    monkeypatch.setattr("sys.stdin", io.StringIO(""))
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)

    first = members_main(
        [
            "seed-anthus",
            "--owner-email",
            "owner@example.com",
            "--yes",
        ],
        plane_factory=lambda: plane,
    )
    second = members_main(
        [
            "seed-anthus",
            "--owner-email",
            "owner@example.com",
            "--yes",
        ],
        plane_factory=lambda: plane,
    )

    assert first == 0
    assert second == 0
    organization = plane.get_organization(ANTHUS_TENANT_ID)
    assert organization.status == OrganizationStatus.ENABLED
    assert (
        plane._messaging_store.get_computer(
            ANTHUS_TENANT_ID,
            ANTHUS_LEGACY_USER_ID,
        )
        is None
    )


def test_members_cli_enable_still_requires_pending(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = InMemoryMessagingStore()
    plane = ControlPlane(messaging_store=store)
    kernel = OrgRecordsKernel(store)
    org = kernel.admin_seed_anthus_organization(
        "owner@example.com",
        name="Anthus",
        now=NOW,
    )
    monkeypatch.setattr("sys.stdin", io.StringIO(""))
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)

    result = members_main(
        ["enable", org.tenant_id, "--yes"], plane_factory=lambda: plane
    )
    assert result == 1

    with pytest.raises(OrganizationStatusTransitionError):
        kernel.enable_organization(org.tenant_id)
