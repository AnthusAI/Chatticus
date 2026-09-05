"""Parse ChatticusComputers stack outputs for customer-account host start."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

COMPUTERS_STACK_NAME = "ChatticusComputers"


@dataclass(frozen=True)
class CustomerComputerEcsConfig:
    """ECS wiring for one organization's ChatticusComputers stack."""

    cluster: str
    task_definition: str
    subnets: list[str]
    security_groups: list[str]


def customer_computer_ecs_config_from_stack_outputs(
    outputs: Mapping[str, str],
    *,
    subnets: list[str],
    security_groups: list[str],
) -> CustomerComputerEcsConfig:
    """Build ECS config from CloudFormation outputs and service network."""
    cluster = outputs.get("ComputerClusterName", "").strip()
    task_definition = outputs.get("ComputerTaskDefinitionArn", "").strip()
    if not cluster or not task_definition or not subnets:
        msg = (
            f"{COMPUTERS_STACK_NAME} stack outputs are incomplete: "
            f"cluster={cluster!r} task_definition={task_definition!r} "
            f"subnets={subnets!r}"
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
