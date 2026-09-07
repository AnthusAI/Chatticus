"""Start organization computers in the account recorded as their AWS home."""

from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

import boto3

from chatticus.computer_start import HostStartClaim
from chatticus.cross_account_assume_role import (
    AssumeRoleCallable,
    attempt_cross_account_assume_role,
)
from chatticus.customer_computers_provision import (
    AwsCustomerComputersProvisioner,
    CustomerComputersProvisioner,
    describe_customer_computers_stack,
)
from chatticus.customer_computers_stack import (
    COMPUTERS_STACK_NAME,
    CustomerComputerEcsConfig,
    customer_computer_ecs_config_from_stack_outputs,
    stack_outputs_from_describe_stacks,
)
from chatticus.deployment_aws_account import deployment_aws_account_id
from chatticus.models import Organization, OrganizationComputerProvisioningError


class OrganizationLookup(Protocol):
    """Load one organization record for host start."""

    def __call__(self, tenant_id: str) -> Organization:
        """Return the organization for *tenant_id*."""


@dataclass(frozen=True)
class DeploymentEcsConfig:
    """Same-account ECS wiring from deployment environment variables."""

    cluster: str
    task_definition: str
    subnets: list[str]
    security_groups: list[str]


@dataclass(frozen=True)
class OrganizationHostStartOutcome:
    """Observable result of one organization host start attempt."""

    launch_account_id: str
    refused: bool = False


def deployment_ecs_config_from_env() -> DeploymentEcsConfig | None:
    """Return deployment ECS wiring when CHATTICUS_HOST_STARTER selects ecs."""
    kind = os.environ.get("CHATTICUS_HOST_STARTER", "noop").strip().lower()
    if kind != "ecs":
        return None
    cluster = os.environ.get("CHATTICUS_ECS_CLUSTER", "").strip()
    task_definition = os.environ.get("CHATTICUS_ECS_TASK_DEFINITION", "").strip()
    subnet_csv = os.environ.get("CHATTICUS_ECS_SUBNETS", "").strip()
    subnets = [part for part in subnet_csv.split(",") if part]
    group_csv = os.environ.get("CHATTICUS_ECS_SECURITY_GROUPS", "").strip()
    security_groups = [part for part in group_csv.split(",") if part]
    if not (cluster and task_definition and subnets):
        return None
    return DeploymentEcsConfig(
        cluster=cluster,
        task_definition=task_definition,
        subnets=subnets,
        security_groups=security_groups,
    )


def lookup_customer_computer_ecs_config(
    cloudformation_client: Any,
    ecs_client: Any,
    *,
    stack_name: str = COMPUTERS_STACK_NAME,
) -> CustomerComputerEcsConfig:
    """Read one customer-account ChatticusComputers stack for RunTask wiring."""
    stack_response = describe_customer_computers_stack(
        cloudformation_client,
        stack_name=stack_name,
    )
    outputs = stack_outputs_from_describe_stacks(stack_response)
    service_name = outputs.get("ComputerServiceName", "").strip()
    cluster = outputs.get("ComputerClusterName", "").strip()
    if not service_name or not cluster:
        msg = (
            f"{stack_name} stack is missing ComputerServiceName or ComputerClusterName."
        )
        raise OrganizationComputerProvisioningError(msg)
    described = ecs_client.describe_services(cluster=cluster, services=[service_name])
    services = described.get("services") or []
    network = (
        services[0].get("networkConfiguration", {}).get("awsvpcConfiguration", {})
        if services
        else {}
    )
    subnets = list(network.get("subnets") or [])
    security_groups = list(network.get("securityGroups") or [])
    try:
        return customer_computer_ecs_config_from_stack_outputs(
            outputs,
            subnets=subnets,
            security_groups=security_groups,
        )
    except ValueError as error:
        raise OrganizationComputerProvisioningError(str(error)) from error


def _require_aws_home(organization: Organization) -> str:
    account_id = organization.aws_account_id
    if not account_id:
        msg = (
            f"Organization {organization.tenant_id!r} has no AWS home; "
            "computer provisioning is required before start."
        )
        raise OrganizationComputerProvisioningError(msg)
    return account_id


def _require_cross_account_fields(organization: Organization) -> None:
    if (
        organization.aws_cross_account_role is None
        or organization.aws_external_id is None
    ):
        msg = (
            f"Organization {organization.tenant_id!r} is homed in another "
            "AWS account but has no cross-account role recorded."
        )
        raise OrganizationComputerProvisioningError(msg)


def run_fargate_task(
    ecs_client: Any,
    *,
    cluster: str,
    task_definition: str,
    subnets: list[str],
    security_groups: list[str],
    claim: HostStartClaim,
) -> None:
    """Run one Fargate task for a host-start claim."""
    response = ecs_client.run_task(
        cluster=cluster,
        taskDefinition=task_definition,
        launchType="FARGATE",
        networkConfiguration={
            "awsvpcConfiguration": {
                "subnets": subnets,
                "securityGroups": security_groups,
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
        **_run_task_overrides(claim),
    )
    failures = (response or {}).get("failures") or []
    tasks = (response or {}).get("tasks") or []
    if failures or not tasks:
        raise RuntimeError(f"ecs.run_task returned no tasks failures={failures!r}")


def _run_task_overrides(claim: HostStartClaim) -> dict[str, object]:
    command = os.environ.get("CHATTICUS_ECS_HOST_COMMAND", "").strip()
    if not command:
        return {}
    container = os.environ.get("CHATTICUS_ECS_CONTAINER_NAME", "computer").strip()
    environment = [
        {"name": "CHATTICUS_TENANT_ID", "value": claim.tenant_id},
        {"name": "CHATTICUS_USER_ID", "value": claim.user_id},
        {"name": "CHATTICUS_COMPUTER_BOOT", "value": "1"},
    ]
    for key in (
        "CHATTICUS_COMPUTER_TURN_QUEUE_URL",
        "CHATTICUS_FRONT_DOOR_URL",
        "CHATTICUS_INVOKE_KEY",
        "CHATTICUS_ENVIRONMENT",
        "CHATTICUS_MESSAGING_TABLE",
        "AWS_REGION",
        "AWS_DEFAULT_REGION",
    ):
        value = os.environ.get(key, "").strip()
        if value:
            environment.append({"name": key, "value": value})
    return {
        "overrides": {
            "containerOverrides": [
                {
                    "name": container,
                    "command": command.split(),
                    "environment": environment,
                }
            ]
        }
    }


class OrganizationComputerHostStarter:
    """Summon one computer host in the organization's recorded AWS home."""

    def __init__(
        self,
        get_organization: OrganizationLookup,
        *,
        deployment_account_id: str | None = None,
        deployment_ecs_config: DeploymentEcsConfig | None = None,
        assume_role: AssumeRoleCallable | None = None,
        ecs_client_factory: Callable[[str | None], Any] | None = None,
        cloudformation_client_factory: Callable[[str | None], Any] | None = None,
        customer_computers_provisioner: CustomerComputersProvisioner | None = None,
        anthus_computer_image_uri: str | None = None,
        anthus_computer_repository_name: str | None = None,
        grant_anthus_computer_image_pull: Callable[[str], None] | None = None,
    ) -> None:
        self._get_organization = get_organization
        self._deployment_account_id = (
            deployment_account_id or deployment_aws_account_id()
        )
        self._deployment_ecs_config = deployment_ecs_config
        self._assume_role = assume_role
        self._ecs_client_factory = ecs_client_factory or self._default_ecs_client
        self._cloudformation_client_factory = (
            cloudformation_client_factory or self._default_cloudformation_client
        )
        self._customer_computers_provisioner = (
            customer_computers_provisioner
            or AwsCustomerComputersProvisioner(
                template_url=_customer_computers_template_url_from_env(),
            )
        )
        self._anthus_computer_image_uri = (
            anthus_computer_image_uri or _anthus_computer_image_uri_from_env()
        )
        self._anthus_computer_repository_name = (
            anthus_computer_repository_name
            or _anthus_computer_repository_name_from_env()
        )
        self._grant_anthus_computer_image_pull = (
            grant_anthus_computer_image_pull
            or _default_grant_anthus_computer_image_pull
        )
        self.last_outcome: OrganizationHostStartOutcome | None = None

    def start_host(self, claim: HostStartClaim) -> None:
        """Run one ECS task in the organization's AWS home account."""
        organization = self._get_organization(claim.tenant_id)
        home_account_id = _require_aws_home(organization)
        if home_account_id == self._deployment_account_id:
            self._start_in_deployment_account(claim, home_account_id)
            return
        self._start_in_customer_account(organization, claim, home_account_id)

    def _start_in_deployment_account(
        self,
        claim: HostStartClaim,
        home_account_id: str,
    ) -> None:
        config = self._deployment_ecs_config or deployment_ecs_config_from_env()
        if config is None:
            self.last_outcome = OrganizationHostStartOutcome(
                launch_account_id=home_account_id,
                refused=False,
            )
            return
        ecs = self._ecs_client_factory(None)
        run_fargate_task(
            ecs,
            cluster=config.cluster,
            task_definition=config.task_definition,
            subnets=config.subnets,
            security_groups=config.security_groups,
            claim=claim,
        )
        self.last_outcome = OrganizationHostStartOutcome(
            launch_account_id=home_account_id
        )

    def _start_in_customer_account(
        self,
        organization: Organization,
        claim: HostStartClaim,
        home_account_id: str,
    ) -> None:
        _require_cross_account_fields(organization)
        assume_role = self._assume_role or self._default_assume_role
        try:
            outcome = attempt_cross_account_assume_role(
                organization,
                assume_role=assume_role,
            )
        except Exception as error:
            msg = (
                f"Organization {organization.tenant_id!r} computer provisioning "
                f"failed: cross-account role could not be assumed ({error})."
            )
            raise OrganizationComputerProvisioningError(msg) from error
        if outcome.refused or outcome.session is None:
            msg = (
                f"Organization {organization.tenant_id!r} computer provisioning "
                "failed: cross-account role refused AssumeRole."
            )
            raise OrganizationComputerProvisioningError(msg)
        session = outcome.session
        ecs = self._ecs_client_factory(
            {
                "aws_access_key_id": session.access_key_id,
                "aws_secret_access_key": session.secret_access_key,
                "aws_session_token": session.session_token,
            }
        )
        cloudformation = self._cloudformation_client_factory(
            {
                "aws_access_key_id": session.access_key_id,
                "aws_secret_access_key": session.secret_access_key,
                "aws_session_token": session.session_token,
            }
        )
        image_uri = self._require_anthus_computer_image_uri()
        self._grant_anthus_computer_image_pull(home_account_id)
        self._customer_computers_provisioner.ensure_stack(
            cloudformation,
            organization,
            anthus_computer_image_uri=image_uri,
        )
        config = lookup_customer_computer_ecs_config(cloudformation, ecs)
        run_fargate_task(
            ecs,
            cluster=config.cluster,
            task_definition=config.task_definition,
            subnets=config.subnets,
            security_groups=config.security_groups,
            claim=claim,
        )
        self.last_outcome = OrganizationHostStartOutcome(
            launch_account_id=home_account_id
        )

    def _require_anthus_computer_image_uri(self) -> str:
        image_uri = self._anthus_computer_image_uri
        if not image_uri:
            msg = (
                "Anthus computer image URI is not configured; "
                "CHATTICUS_ANTHUS_COMPUTER_IMAGE_URI is required for customer start."
            )
            raise OrganizationComputerProvisioningError(msg)
        return image_uri

    @staticmethod
    def _default_ecs_client(credentials: dict[str, str] | None) -> Any:
        if credentials is None:
            return boto3.client("ecs")
        return boto3.client("ecs", **credentials)

    @staticmethod
    def _default_cloudformation_client(
        credentials: dict[str, str] | None,
    ) -> Any:
        if credentials is None:
            return boto3.client("cloudformation")
        return boto3.client("cloudformation", **credentials)

    @staticmethod
    def _default_assume_role(**kwargs: object) -> dict[str, object]:
        return boto3.client("sts").assume_role(**kwargs)


def _anthus_computer_image_uri_from_env() -> str | None:
    value = os.environ.get("CHATTICUS_ANTHUS_COMPUTER_IMAGE_URI", "").strip()
    return value or None


def _anthus_computer_repository_name_from_env() -> str | None:
    value = os.environ.get("CHATTICUS_ANTHUS_COMPUTER_REPOSITORY_NAME", "").strip()
    return value or None


def _customer_computers_template_url_from_env() -> str | None:
    value = os.environ.get("CHATTICUS_CUSTOMER_COMPUTERS_TEMPLATE_URL", "").strip()
    return value or None


def _default_grant_anthus_computer_image_pull(customer_account_id: str) -> None:
    repository_name = _anthus_computer_repository_name_from_env()
    if not repository_name:
        msg = (
            "Anthus computer repository name is not configured; "
            "CHATTICUS_ANTHUS_COMPUTER_REPOSITORY_NAME is required for customer start."
        )
        raise OrganizationComputerProvisioningError(msg)
    from chatticus.anthus_computer_ecr_pull import (
        grant_customer_account_anthus_computer_image_pull,
    )

    ecr_client = boto3.client("ecr")
    grant_customer_account_anthus_computer_image_pull(
        ecr_client,
        repository_name=repository_name,
        customer_account_id=customer_account_id,
    )
