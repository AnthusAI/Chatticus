"""Start a household computer host once per host_start_generation lease."""

from __future__ import annotations

import os
from typing import Any, Protocol

from chatticus.computer_start import HostStartClaim


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


class EcsHostStarter:
    """Optional ECS RunTask starter gated by environment configuration."""

    def __init__(
        self,
        *,
        ecs_client: Any | None = None,
        cluster: str | None = None,
        task_definition: str | None = None,
        subnets: list[str] | None = None,
        security_groups: list[str] | None = None,
    ) -> None:
        self._ecs = ecs_client
        self._cluster = cluster or os.environ.get("CHATTICUS_ECS_CLUSTER", "").strip()
        self._task_definition = (
            task_definition
            or os.environ.get("CHATTICUS_ECS_TASK_DEFINITION", "").strip()
        )
        subnet_csv = os.environ.get("CHATTICUS_ECS_SUBNETS", "").strip()
        self._subnets = subnets or [part for part in subnet_csv.split(",") if part]
        group_csv = os.environ.get("CHATTICUS_ECS_SECURITY_GROUPS", "").strip()
        self._security_groups = security_groups or [
            part for part in group_csv.split(",") if part
        ]

    def start_host(self, claim: HostStartClaim) -> None:
        """Run one ECS task when cluster wiring is configured."""
        if not (self._cluster and self._task_definition and self._subnets):
            return
        ecs = self._ecs
        if ecs is None:
            import boto3

            ecs = boto3.client("ecs")
        ecs.run_task(
            cluster=self._cluster,
            taskDefinition=self._task_definition,
            launchType="FARGATE",
            networkConfiguration={
                "awsvpcConfiguration": {
                    "subnets": self._subnets,
                    "securityGroups": self._security_groups,
                    "assignPublicIp": "ENABLED",
                }
            },
            tags=[
                {"key": "tenant_id", "value": claim.tenant_id},
                {"key": "computer_id", "value": claim.computer_id},
                {
                    "key": "host_start_generation",
                    "value": str(claim.host_start_count),
                },
            ],
        )


def host_starter_from_env() -> HostStarter:
    """Return the configured host starter, defaulting to a no-op."""
    kind = os.environ.get("CHATTICUS_HOST_STARTER", "noop").strip().lower()
    if kind == "ecs":
        return EcsHostStarter()
    return NoOpHostStarter()
