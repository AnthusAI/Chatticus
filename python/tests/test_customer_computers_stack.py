"""Unit tests for customer ChatticusComputers stack output parsing."""

from __future__ import annotations

import pytest

from chatticus.customer_computers_stack import (
    customer_computer_ecs_config_from_stack_outputs,
    parse_public_subnet_ids,
    stack_has_run_task_outputs,
    stack_outputs_from_describe_stacks,
)


def test_stack_outputs_from_describe_stacks() -> None:
    outputs = stack_outputs_from_describe_stacks(
        {
            "Stacks": [
                {
                    "Outputs": [
                        {
                            "OutputKey": "ComputerClusterName",
                            "OutputValue": "cluster-a",
                        },
                        {
                            "OutputKey": "ComputerTaskDefinitionArn",
                            "OutputValue": "arn:task/computer:1",
                        },
                    ]
                }
            ]
        }
    )
    assert outputs["ComputerClusterName"] == "cluster-a"
    assert outputs["ComputerTaskDefinitionArn"] == "arn:task/computer:1"


def test_parse_public_subnet_ids() -> None:
    assert parse_public_subnet_ids("subnet-1,subnet-2") == ["subnet-1", "subnet-2"]
    assert parse_public_subnet_ids("") == []


def test_stack_has_run_task_outputs() -> None:
    assert stack_has_run_task_outputs(
        {
            "ComputerClusterName": "cluster-a",
            "ComputerTaskDefinitionArn": "arn:task/computer:1",
            "ComputerPublicSubnetIds": "subnet-1",
            "ComputerSecurityGroupId": "sg-1",
        }
    )
    assert not stack_has_run_task_outputs(
        {
            "ComputerClusterName": "cluster-a",
            "ComputerTaskDefinitionArn": "arn:task/computer:1",
        }
    )


def test_customer_computer_ecs_config_from_stack_outputs() -> None:
    config = customer_computer_ecs_config_from_stack_outputs(
        {
            "ComputerClusterName": "cluster-a",
            "ComputerTaskDefinitionArn": "arn:task/computer:1",
            "ComputerPublicSubnetIds": "subnet-1,subnet-2",
            "ComputerSecurityGroupId": "sg-1",
        }
    )
    assert config.cluster == "cluster-a"
    assert config.task_definition == "arn:task/computer:1"
    assert config.subnets == ["subnet-1", "subnet-2"]
    assert config.security_groups == ["sg-1"]


def test_customer_computer_ecs_config_rejects_incomplete_outputs() -> None:
    with pytest.raises(ValueError, match="incomplete"):
        customer_computer_ecs_config_from_stack_outputs(
            {
                "ComputerClusterName": "cluster-a",
                "ComputerTaskDefinitionArn": "arn:task/computer:1",
            }
        )
