"""Resolve the AWS account id for this Chatticus deployment."""

from __future__ import annotations

import os

DEFAULT_DEPLOYMENT_AWS_ACCOUNT_ID = "999999999999"


def deployment_aws_account_id() -> str:
    """Return the twelve-digit AWS account id where this deployment runs."""
    configured = os.environ.get("CHATTICUS_DEPLOYMENT_AWS_ACCOUNT_ID", "").strip()
    if configured:
        return configured
    return DEFAULT_DEPLOYMENT_AWS_ACCOUNT_ID
