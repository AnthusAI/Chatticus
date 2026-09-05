"""Tests for first organization seed and cold bootstrap paths."""

from __future__ import annotations

import io
from datetime import UTC, datetime

import pytest

from chatticus.control_plane import ControlPlane
from chatticus.members.__main__ import main as members_main
from chatticus.messaging.store import InMemoryMessagingStore
from chatticus.models import (
    ActorKind,
    AwsSetupPath,
    Bot,
    Channel,
    ChannelParticipant,
    IdentityUserIdMismatchError,
    MemberRole,
    OrganizationSeedConflictError,
    OrganizationStatus,
    OrganizationStatusTransitionError,
)
from chatticus.org_records import (
    ANTHUS_LEGACY_USER_ID,
    ANTHUS_TENANT_ID,
    OrgRecordsKernel,
)

NOW = datetime(2026, 8, 31, 12, 0, 0, tzinfo=UTC)


def _legacy_channel(
    tenant_id: str, user_id: str, *, channel_id: str = "ch-1"
) -> Channel:
    return Channel(
        channel_id=channel_id,
        tenant_id=tenant_id,
        participants=[ChannelParticipant(kind=ActorKind.HUMAN, actor_id=user_id)],
    )


def test_admin_seed_organization_aligns_with_messaging_user_id() -> None:
    store = InMemoryMessagingStore()
    store.put_channel(_legacy_channel(ANTHUS_TENANT_ID, ANTHUS_LEGACY_USER_ID))
    store.put_bot(
        Bot(
            bot_id="bot-1",
            tenant_id=ANTHUS_TENANT_ID,
            name="Researcher",
        ),
        reserve_name=True,
    )
    plane = ControlPlane(messaging_store=store)

    organization = plane.admin_seed_organization(
        ANTHUS_TENANT_ID,
        "owner@example.com",
        name="Anthus",
        now=NOW,
    )

    assert organization.tenant_id == ANTHUS_TENANT_ID
    assert organization.status == OrganizationStatus.ENABLED
    assert organization.aws_account_id is not None
    assert organization.aws_setup_path == AwsSetupPath.ANTHUS_MANAGED
    identity = store.get_identity_by_email("owner@example.com")
    assert identity is not None
    assert identity.user_id == ANTHUS_LEGACY_USER_ID
    membership = store.get_membership(ANTHUS_TENANT_ID, ANTHUS_LEGACY_USER_ID)
    assert membership is not None
    assert membership.role == MemberRole.OWNER
    assert store.get_computer(ANTHUS_TENANT_ID) is None
    loaded = store.get_bot(ANTHUS_TENANT_ID, "bot-1")
    assert loaded is not None
    assert loaded.name == "Researcher"


def test_admin_seed_organization_is_idempotent() -> None:
    store = InMemoryMessagingStore()
    kernel = OrgRecordsKernel(store)
    first = kernel.admin_seed_organization(
        ANTHUS_TENANT_ID,
        "owner@example.com",
        name="Anthus",
        now=NOW,
    )
    second = kernel.admin_seed_organization(
        ANTHUS_TENANT_ID,
        "owner@example.com",
        name="Anthus",
        now=NOW,
    )
    assert second == first
    assert len(kernel.list_organizations_by_status(OrganizationStatus.ENABLED)) == 1


def test_admin_seed_organization_enables_pending_org() -> None:
    store = InMemoryMessagingStore()
    kernel = OrgRecordsKernel(store)
    owner = kernel._admin_ensure_seed_owner_identity(
        ANTHUS_TENANT_ID,
        "owner@example.com",
        now=NOW,
    )
    kernel._put_pending_organization(
        owner,
        "Anthus",
        tenant_id=ANTHUS_TENANT_ID,
        now=NOW,
    )

    organization = kernel.admin_seed_organization(
        ANTHUS_TENANT_ID,
        "owner@example.com",
        name="Anthus",
        now=NOW,
    )

    assert organization.status == OrganizationStatus.ENABLED


def test_admin_seed_organization_rejects_conflicting_identity_user_id() -> None:
    store = InMemoryMessagingStore()
    kernel = OrgRecordsKernel(store)
    store.put_channel(_legacy_channel(ANTHUS_TENANT_ID, ANTHUS_LEGACY_USER_ID))
    kernel.sign_in("owner@example.com", now=NOW)

    with pytest.raises(IdentityUserIdMismatchError):
        kernel.admin_seed_organization(
            ANTHUS_TENANT_ID,
            "owner@example.com",
            name="Anthus",
            now=NOW,
        )


def test_admin_seed_organization_rejects_multiple_messaging_user_ids() -> None:
    store = InMemoryMessagingStore()
    kernel = OrgRecordsKernel(store)
    store.put_channel(_legacy_channel(ANTHUS_TENANT_ID, "ryan", channel_id="ch-1"))
    store.put_channel(_legacy_channel(ANTHUS_TENANT_ID, "alex", channel_id="ch-2"))

    with pytest.raises(OrganizationSeedConflictError):
        kernel.admin_seed_organization(
            ANTHUS_TENANT_ID,
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
    assert plane._messaging_store.get_computer(tenant_id) is None


def test_members_cli_seed_without_computer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = InMemoryMessagingStore()
    store.put_channel(_legacy_channel(ANTHUS_TENANT_ID, ANTHUS_LEGACY_USER_ID))
    store.put_bot(
        Bot(
            bot_id="bot-1",
            tenant_id=ANTHUS_TENANT_ID,
            name="Researcher",
        ),
        reserve_name=True,
    )
    plane = ControlPlane(messaging_store=store)
    monkeypatch.setattr("sys.stdin", io.StringIO(""))
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)

    first = members_main(
        [
            "seed",
            "--tenant-id",
            ANTHUS_TENANT_ID,
            "--owner-email",
            "owner@example.com",
            "--yes",
        ],
        plane_factory=lambda: plane,
    )
    second = members_main(
        [
            "seed",
            "--tenant-id",
            ANTHUS_TENANT_ID,
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
    assert plane._messaging_store.get_computer(ANTHUS_TENANT_ID) is None


def test_members_cli_seed_anthus_cold_path_empty_store(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Seed anthus enabled on an empty store with Anthus AI Solutions display name."""
    store = InMemoryMessagingStore()
    plane = ControlPlane(messaging_store=store)
    monkeypatch.setattr("sys.stdin", io.StringIO(""))
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)

    result = members_main(
        [
            "seed",
            "--tenant-id",
            ANTHUS_TENANT_ID,
            "--owner-email",
            "ryan@anth.us",
            "--name",
            "Anthus AI Solutions",
            "--yes",
        ],
        plane_factory=lambda: plane,
    )
    assert result == 0

    organization = plane.get_organization(ANTHUS_TENANT_ID)
    assert organization.status == OrganizationStatus.ENABLED
    assert organization.name == "Anthus AI Solutions"
    identity = store.get_identity_by_email("ryan@anth.us")
    assert identity is not None
    assert identity.email == "ryan@anth.us"
    membership = store.get_membership(ANTHUS_TENANT_ID, identity.user_id)
    assert membership is not None
    assert membership.role == MemberRole.OWNER
    assert plane._messaging_store.get_computer(ANTHUS_TENANT_ID) is None


def test_members_cli_enable_still_requires_pending(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = InMemoryMessagingStore()
    plane = ControlPlane(messaging_store=store)
    kernel = OrgRecordsKernel(store)
    org = kernel.admin_seed_organization(
        ANTHUS_TENANT_ID,
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
