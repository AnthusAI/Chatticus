"""Gherkin steps for Fargate host pull-worker RunTask overrides."""

from __future__ import annotations

import os

from behave import given, then, when

from chatticus.computer_start import HostStartClaim
from chatticus.organization_computer_host import run_fargate_task


class _FakeEcs:
    def __init__(self) -> None:
        self.kwargs: dict[str, object] | None = None

    def run_task(self, **kwargs: object) -> dict[str, object]:
        self.kwargs = kwargs
        return {"tasks": [{"taskArn": "arn:ecs:task/gherkin"}], "failures": []}


@given("CHATTICUS_ECS_HOST_COMMAND is the computer host worker module")
def given_ecs_host_command(context: object) -> None:
    os.environ["CHATTICUS_ECS_HOST_COMMAND"] = (
        "python -m chatticus.computer_host_worker"
    )
    os.environ["CHATTICUS_ECS_CONTAINER_NAME"] = "computer"
    context.fake_ecs = _FakeEcs()  # type: ignore[attr-defined]


@when("the ECS host starter starts a host for a claim")
def when_ecs_host_starter_starts(context: object) -> None:
    run_fargate_task(
        context.fake_ecs,  # type: ignore[attr-defined]
        cluster="ChatticusComputers",
        task_definition="computer",
        subnets=["subnet-1"],
        security_groups=["sg-1"],
        claim=HostStartClaim(
            tenant_id="anthus",
            computer_id="household-computer",
            host_start_count=1,
            user_id="ryan",
        ),
    )


@then("RunTask overrides that container command")
def then_runtask_overrides_command(context: object) -> None:
    kwargs = context.fake_ecs.kwargs  # type: ignore[attr-defined]
    assert kwargs is not None
    overrides = kwargs["overrides"]
    container = overrides["containerOverrides"][0]  # type: ignore[index]
    assert container["name"] == "computer"
    assert container["command"] == [
        "python",
        "-m",
        "chatticus.computer_host_worker",
    ]
