"""Start a household computer host once per host_start_generation lease."""

from __future__ import annotations

from collections.abc import Callable
from typing import Protocol

from chatticus.computer_start import HostStartClaim
from chatticus.deployment_aws_account import deployment_aws_account_id
from chatticus.models import Organization


class HostStarter(Protocol):
    """Summon one computer host for one durable host-start claim."""

    def start_host(self, claim: HostStartClaim) -> None:
        """Start or schedule one host for the given claim."""


class NoOpHostStarter:
    """Default starter that records intent only in the control plane."""

    def start_host(self, claim: HostStartClaim) -> None:
        """Do nothing; host boot is exercised in later slices."""


class RecordingHostStarter:
    """Capture host-start invocations for kernel and behavior specs."""

    def __init__(self) -> None:
        self.invocations: list[HostStartClaim] = []

    def start_host(self, claim: HostStartClaim) -> None:
        """Record one host-start claim."""
        self.invocations.append(claim)


def host_starter_from_env(
    get_organization: Callable[[str], Organization] | None = None,
) -> HostStarter:
    """Return the configured host starter for this deployment."""
    if get_organization is None:
        return NoOpHostStarter()
    from chatticus.organization_computer_host import (
        OrganizationComputerHostStarter,
        deployment_ecs_config_from_env,
    )

    return OrganizationComputerHostStarter(
        get_organization,
        deployment_account_id=deployment_aws_account_id(),
        deployment_ecs_config=deployment_ecs_config_from_env(),
    )
