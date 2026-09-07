"""Parse ChatticusComputers stack outputs for customer-account host start."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

COMPUTERS_STACK_NAME = "ChatticusComputers"
COMPUTER_PUBLIC_SUBNET_IDS_OUTPUT = "ComputerPublicSubnetIds"
COMPUTER_SECURITY_GROUP_ID_OUTPUT = "ComputerSecurityGroupId"
COMPUTER_REPOSITORY_URI_OUTPUT = "ComputerRepositoryUri"


@dataclass(frozen=True)
class CustomerComputerEcsConfig:
    """ECS wiring for one organization's ChatticusComputers stack."""

    cluster: str
    task_definition: str
    subnets: list[str]
    security_groups: list[str]


def parse_public_subnet_ids(subnet_csv: str) -> list[str]:
    """Split one comma-separated public subnet output into subnet ids."""
    return [part.strip() for part in subnet_csv.split(",") if part.strip()]


def network_from_stack_outputs(
    outputs: Mapping[str, str],
) -> tuple[list[str], list[str]]:
    """Return subnet ids and security group ids from stack outputs."""
    subnets = parse_public_subnet_ids(
        outputs.get(COMPUTER_PUBLIC_SUBNET_IDS_OUTPUT, "")
    )
    security_group = outputs.get(COMPUTER_SECURITY_GROUP_ID_OUTPUT, "").strip()
    security_groups = [security_group] if security_group else []
    return subnets, security_groups


def stack_has_run_task_outputs(outputs: Mapping[str, str]) -> bool:
    """Return whether *outputs* include RunTask wiring from the committed template."""
    cluster = outputs.get("ComputerClusterName", "").strip()
    task_definition = outputs.get("ComputerTaskDefinitionArn", "").strip()
    repository_uri = outputs.get(COMPUTER_REPOSITORY_URI_OUTPUT, "").strip()
    subnets, security_groups = network_from_stack_outputs(outputs)
    return bool(
        cluster and task_definition and subnets and security_groups and repository_uri
    )


def customer_computer_ecs_config_from_stack_outputs(
    outputs: Mapping[str, str],
) -> CustomerComputerEcsConfig:
    """Build ECS config from CloudFormation outputs."""
    cluster = outputs.get("ComputerClusterName", "").strip()
    task_definition = outputs.get("ComputerTaskDefinitionArn", "").strip()
    subnets, security_groups = network_from_stack_outputs(outputs)
    if not cluster or not task_definition or not subnets:
        msg = (
            f"{COMPUTERS_STACK_NAME} stack outputs are incomplete: "
            f"cluster={cluster!r} task_definition={task_definition!r} "
            f"subnets={subnets!r} "
            f"{COMPUTER_PUBLIC_SUBNET_IDS_OUTPUT}="
            f"{outputs.get(COMPUTER_PUBLIC_SUBNET_IDS_OUTPUT)!r} "
            f"{COMPUTER_SECURITY_GROUP_ID_OUTPUT}="
            f"{outputs.get(COMPUTER_SECURITY_GROUP_ID_OUTPUT)!r}"
        )
        raise ValueError(msg)
    return CustomerComputerEcsConfig(
        cluster=cluster,
        task_definition=task_definition,
        subnets=list(subnets),
        security_groups=list(security_groups),
    )


def stack_outputs_from_describe_stacks(
    response: Mapping[str, object],
) -> dict[str, str]:
    """Extract output key/value pairs from one DescribeStacks response."""
    stacks = response.get("Stacks") or []
    if not stacks:
        return {}
    raw_outputs = stacks[0].get("Outputs") or []
    outputs: dict[str, str] = {}
    for item in raw_outputs:
        if not isinstance(item, dict):
            continue
        key = item.get("OutputKey")
        value = item.get("OutputValue")
        if isinstance(key, str) and isinstance(value, str) and key:
            outputs[key] = value
    return outputs
