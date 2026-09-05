"""Resolve the AWS account id for this Chatticus deployment."""

from __future__ import annotations

import os
from collections.abc import Callable
from typing import Any

import boto3

from chatticus.models import ChatticusError


class DeploymentAwsAccountIdError(ChatticusError):
    """Raised when the deployment AWS account id cannot be resolved."""


def deployment_aws_account_id() -> str:
    """Return the twelve-digit AWS account id where this deployment runs.

    Lambda and other runtime paths must set ``CHATTICUS_DEPLOYMENT_AWS_ACCOUNT_ID``.
    There is no default account id.
    """
    configured = os.environ.get("CHATTICUS_DEPLOYMENT_AWS_ACCOUNT_ID", "").strip()
    if configured:
        return configured
    msg = (
        "CHATTICUS_DEPLOYMENT_AWS_ACCOUNT_ID is not set; "
        "the deployment AWS account id is required."
    )
    raise DeploymentAwsAccountIdError(msg)


def caller_aws_account_id(
    *,
    get_caller_identity: Callable[[], dict[str, Any]] | None = None,
) -> str:
    """Return the AWS account id of the current caller.

    Used by operator seed so the Anthus-managed home account matches the
    credentials running ``python -m chatticus.members seed``.
    """
    if get_caller_identity is None:
        get_caller_identity = boto3.client("sts").get_caller_identity
    account_id = str(get_caller_identity().get("Account", "")).strip()
    if account_id:
        return account_id
    msg = "STS get_caller_identity did not return an AWS account id."
    raise DeploymentAwsAccountIdError(msg)
