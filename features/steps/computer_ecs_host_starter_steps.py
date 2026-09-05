"""Gherkin steps for ECS host starter environment selection."""

from __future__ import annotations

import os
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch

from behave import given, then, when

from chatticus.computer_start import HostStartClaim
from chatticus.host_starter import NoOpHostStarter, host_starter_from_env
from chatticus.models import AwsSetupPath, Organization, OrganizationStatus
from chatticus.organization_computer_host import OrganizationComputerHostStarter


def _seeded_organization() -> Organization:
    return Organization(
        tenant_id="anthus",
        name="Anthus",
        status=OrganizationStatus.ENABLED,
        owner_user_id="owner",
        created_at=datetime(2026, 8, 31, 12, 0, 0, tzinfo=UTC),
        aws_account_id="123456789012",
        aws_setup_path=AwsSetupPath.ANTHUS_MANAGED,
    )


@given("CHATTICUS_HOST_STARTER is ecs")
def given_host_starter_ecs(context: object) -> None:
    os.environ["CHATTICUS_HOST_STARTER"] = "ecs"


@given("CHATTICUS_HOST_STARTER is not ecs")
def given_host_starter_not_ecs(context: object) -> None:
    os.environ.pop("CHATTICUS_HOST_STARTER", None)
    os.environ.pop("CHATTICUS_DEPLOYMENT_AWS_ACCOUNT_ID", None)


@given("an organization lookup is available for host start")
def given_organization_lookup_for_host_start(context: object) -> None:
    context.get_organization = lambda _tenant_id: _seeded_organization()  # type: ignore[attr-defined]


@then("the host starter from environment is an OrganizationComputerHostStarter")
def then_host_starter_is_organization_starter(context: object) -> None:
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


@then("the host starter from environment is a no-op host starter")
def then_host_starter_is_noop(context: object) -> None:
    starter = host_starter_from_env(context.get_organization)  # type: ignore[attr-defined]
    assert isinstance(starter, NoOpHostStarter)
    context.host_starter = starter  # type: ignore[attr-defined]


@when("the host starter from environment starts a host")
def when_host_starter_starts_host(context: object) -> None:
    starter = context.host_starter  # type: ignore[attr-defined]
    claim = HostStartClaim(
        tenant_id="anthus",
        computer_id="household-computer",
        host_start_count=1,
    )
    with patch("boto3.client") as mock_client:
        starter.start_host(claim)
        context.boto3_client_called = mock_client.called  # type: ignore[attr-defined]


@then("no ECS RunTask was attempted")
@then("no cross-account AssumeRole was attempted")
def then_no_aws_api_calls(context: object) -> None:
    assert context.boto3_client_called is False  # type: ignore[attr-defined]


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
