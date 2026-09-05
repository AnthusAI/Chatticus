"""Gherkin steps for ECS host starter environment selection."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from behave import given, then

from chatticus.host_starter import host_starter_from_env
from chatticus.models import AwsSetupPath, Organization, OrganizationStatus
from chatticus.organization_computer_host import OrganizationComputerHostStarter


@given("CHATTICUS_HOST_STARTER is ecs")
def given_host_starter_ecs(context: object) -> None:
    import os

    os.environ["CHATTICUS_HOST_STARTER"] = "ecs"


@then("the host starter from environment is an OrganizationComputerHostStarter")
def then_host_starter_is_organization_starter(context: object) -> None:
    import os

    deployment_account_id = os.environ["CHATTICUS_DEPLOYMENT_AWS_ACCOUNT_ID"]
    seeded = Organization(
        tenant_id="anthus",
        name="Anthus",
        status=OrganizationStatus.ENABLED,
        owner_user_id="owner",
        created_at=datetime(2026, 8, 31, 12, 0, 0, tzinfo=UTC),
        aws_account_id=deployment_account_id,
        aws_setup_path=AwsSetupPath.ANTHUS_MANAGED,
    )
    assert isinstance(
        host_starter_from_env(lambda _tenant_id: seeded),
        OrganizationComputerHostStarter,
    )


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
    assert "sts:AssumeRole" in text
