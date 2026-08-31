"""Gherkin steps for ECS host starter environment selection."""

from __future__ import annotations

from behave import given, then

from chatticus.host_starter import EcsHostStarter, host_starter_from_env


@given("CHATTICUS_HOST_STARTER is ecs")
def given_host_starter_ecs(context: object) -> None:
    import os

    os.environ["CHATTICUS_HOST_STARTER"] = "ecs"


@then("the host starter from environment is an ECS host starter")
def then_host_starter_is_ecs(context: object) -> None:
    assert isinstance(host_starter_from_env(), EcsHostStarter)
