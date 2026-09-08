"""Unit tests for customer ChatticusComputers template helpers."""

from __future__ import annotations

import json

import pytest
from botocore.exceptions import ClientError

from chatticus.customer_computers_template import (
    CREATE_STACK_TEMPLATE_BYTE_LIMIT,
    create_stack_capabilities,
    customer_computers_create_stack_parameters,
    is_no_stack_updates_error,
    is_stack_missing_error,
    load_customer_computers_template,
    template_delivery_for_create_stack,
)


def test_create_stack_capabilities() -> None:
    assert create_stack_capabilities() == ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"]


def test_is_stack_missing_error_validation_error() -> None:
    error = ClientError(
        {"Error": {"Code": "ValidationError", "Message": "does not exist"}},
        "DescribeStacks",
    )
    assert is_stack_missing_error(error) is True


def test_is_stack_missing_error_other_code() -> None:
    error = ClientError(
        {"Error": {"Code": "AccessDenied", "Message": "nope"}},
        "DescribeStacks",
    )
    assert is_stack_missing_error(error) is False


def test_template_delivery_uses_body_under_limit() -> None:
    body = "x" * CREATE_STACK_TEMPLATE_BYTE_LIMIT
    delivery = template_delivery_for_create_stack(body)
    assert delivery == {"TemplateBody": body}


def test_template_delivery_uses_url_over_limit() -> None:
    body = "x" * (CREATE_STACK_TEMPLATE_BYTE_LIMIT + 1)
    delivery = template_delivery_for_create_stack(
        body,
        template_url="https://example-bucket.s3.amazonaws.com/template.json",
    )
    assert delivery == {
        "TemplateURL": "https://example-bucket.s3.amazonaws.com/template.json"
    }


def test_template_delivery_over_limit_without_url_raises() -> None:
    body = "x" * (CREATE_STACK_TEMPLATE_BYTE_LIMIT + 1)
    with pytest.raises(ValueError, match="no template URL"):
        template_delivery_for_create_stack(body)


def test_customer_computers_create_stack_parameters() -> None:
    parameters = customer_computers_create_stack_parameters(
        tenant_id="tenant-1",
    )
    assert parameters == [
        {"ParameterKey": "TenantId", "ParameterValue": "tenant-1"},
    ]


def test_committed_customer_computers_template_is_under_body_limit() -> None:
    template = load_customer_computers_template()
    body = json.dumps(template, separators=(",", ":"))
    assert len(body.encode("utf-8")) <= CREATE_STACK_TEMPLATE_BYTE_LIMIT
    assert "AWS::S3::Bucket" not in body
    assert "SnapshotBucketName" not in body
    assert "AWS::ECR::Repository" in body


def test_committed_template_has_no_cdk_bootstrap() -> None:
    template = load_customer_computers_template()
    parameters = template.get("Parameters", {})
    assert set(parameters.keys()) == {"TenantId"}
    rules = template.get("Rules", {})
    assert "CheckBootstrapVersion" not in rules
    body = json.dumps(template)
    assert "AWS::SSM::Parameter::Value" not in body
    assert "/cdk-bootstrap/" not in body


def test_committed_template_exports_run_task_network_outputs() -> None:
    template = load_customer_computers_template()
    outputs = template.get("Outputs", {})
    assert "ComputerPublicSubnetIds" in outputs
    assert "ComputerSecurityGroupId" in outputs


def test_is_no_stack_updates_error() -> None:
    error = ClientError(
        {
            "Error": {
                "Code": "ValidationError",
                "Message": "No updates are to be performed.",
            }
        },
        "UpdateStack",
    )
    assert is_no_stack_updates_error(error) is True


def test_is_no_stack_updates_error_rejects_other_errors() -> None:
    error = ClientError(
        {"Error": {"Code": "AccessDenied", "Message": "nope"}},
        "UpdateStack",
    )
    assert is_no_stack_updates_error(error) is False
