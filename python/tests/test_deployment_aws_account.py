"""Kernel tests for deployment AWS account resolution."""

from __future__ import annotations

import pytest

from chatticus.deployment_aws_account import (
    DeploymentAwsAccountIdError,
    caller_aws_account_id,
    deployment_aws_account_id,
)


def test_deployment_aws_account_id_requires_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("CHATTICUS_DEPLOYMENT_AWS_ACCOUNT_ID", raising=False)
    with pytest.raises(DeploymentAwsAccountIdError):
        deployment_aws_account_id()


def test_deployment_aws_account_id_reads_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CHATTICUS_DEPLOYMENT_AWS_ACCOUNT_ID", "222233334444")
    assert deployment_aws_account_id() == "222233334444"


def test_caller_aws_account_id_reads_sts_account() -> None:
    assert (
        caller_aws_account_id(
            get_caller_identity=lambda: {"Account": "333344445555"},
        )
        == "333344445555"
    )


def test_caller_aws_account_id_fails_when_sts_has_no_account() -> None:
    with pytest.raises(DeploymentAwsAccountIdError):
        caller_aws_account_id(get_caller_identity=lambda: {})
