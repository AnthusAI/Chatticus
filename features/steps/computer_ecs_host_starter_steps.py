"""Gherkin steps for ECS host starter environment selection."""

from __future__ import annotations

from pathlib import Path

from behave import given, then

from chatticus.host_starter import EcsHostStarter, host_starter_from_env


@given("CHATTICUS_HOST_STARTER is ecs")
def given_host_starter_ecs(context: object) -> None:
    import os

    os.environ["CHATTICUS_HOST_STARTER"] = "ecs"


@then("the host starter from environment is an ECS host starter")
def then_host_starter_is_ecs(context: object) -> None:
    assert isinstance(host_starter_from_env(), EcsHostStarter)


@given("development ThinTurn ComputerWorker is wired for ECS host start")
def given_thinturn_ecs_host_start_source(context: object) -> None:
    root = Path(__file__).resolve().parents[2]
    context.host_start_source = (  # type: ignore[attr-defined]
        root / "infra" / "lib" / "computer-host-start.ts"
    ).read_text()


@then("ComputerWorker IAM allows ecs TagResource on summoned tasks")
def then_iam_allows_tag_resource(context: object) -> None:
    text = context.host_start_source  # type: ignore[attr-defined]
    assert "ecs:TagResource" in text
    assert "ecs:RunTask" in text
