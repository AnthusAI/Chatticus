"""Kernel tests for the host-start driver protocol."""

from __future__ import annotations

from chatticus.computer_start import HostStartClaim
from chatticus.host_starter import (
    NoOpHostStarter,
    RecordingHostStarter,
    host_starter_from_env,
)
from chatticus.organization_computer_host import OrganizationComputerHostStarter


def test_noop_host_starter_accepts_claims() -> None:
    claim = HostStartClaim(
        tenant_id="anthus",
        computer_id="household-computer",
        host_start_count=1,
    )
    NoOpHostStarter().start_host(claim)


def test_recording_host_starter_captures_claims() -> None:
    starter = RecordingHostStarter()
    claim = HostStartClaim(
        tenant_id="anthus",
        computer_id="household-computer",
        host_start_count=2,
        waiting_turn_ids=["turn-1"],
    )
    starter.start_host(claim)
    assert starter.invocations == [claim]


def test_host_starter_from_env_defaults_to_noop(monkeypatch: object) -> None:
    monkeypatch.delenv("CHATTICUS_HOST_STARTER", raising=False)  # type: ignore[attr-defined]
    assert isinstance(host_starter_from_env(), NoOpHostStarter)


def test_host_starter_from_env_selects_organization_starter(
    monkeypatch: object,
) -> None:
    from datetime import UTC, datetime

    from chatticus.models import AwsSetupPath, Organization, OrganizationStatus

    monkeypatch.setenv("CHATTICUS_HOST_STARTER", "ecs")  # type: ignore[attr-defined]
    seeded = Organization(
        tenant_id="anthus",
        name="Anthus",
        status=OrganizationStatus.ENABLED,
        owner_user_id="owner",
        created_at=datetime(2026, 8, 31, 12, 0, 0, tzinfo=UTC),
        aws_account_id="999999999999",
        aws_setup_path=AwsSetupPath.ANTHUS_MANAGED,
    )
    assert isinstance(
        host_starter_from_env(lambda _tenant_id: seeded),
        OrganizationComputerHostStarter,
    )
