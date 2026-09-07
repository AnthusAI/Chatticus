"""Unit tests for Anthus ECR cross-account pull policy helpers."""

from __future__ import annotations

import json

from chatticus.anthus_computer_ecr_pull import (
    ECR_PULL_ACTIONS,
    customer_account_ecr_pull_principal,
    grant_customer_account_anthus_computer_image_pull,
    merge_customer_account_ecr_pull_statement,
)


class _RecordingEcrRepositoryPolicy:
    def __init__(self) -> None:
        self.repository_name: str | None = None
        self.policy_text: str | None = None

    def get_repository_policy(self, *, repositoryName: str) -> dict[str, object]:
        raise _RepositoryPolicyNotFound(repositoryName)

    def set_repository_policy(
        self,
        *,
        repositoryName: str,
        policyText: str,
    ) -> dict[str, object]:
        self.repository_name = repositoryName
        self.policy_text = policyText
        return {}


class _RepositoryPolicyNotFound(Exception):
    def __init__(self, repository_name: str) -> None:
        super().__init__(repository_name)
        self.response = {"Error": {"Code": "RepositoryPolicyNotFoundException"}}


def test_ecr_pull_actions_include_batch_check_layer_availability() -> None:
    assert ECR_PULL_ACTIONS == (
        "ecr:BatchCheckLayerAvailability",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer",
    )


def test_merge_customer_account_ecr_pull_statement_actions() -> None:
    merged = merge_customer_account_ecr_pull_statement(
        {"Version": "2012-10-17", "Statement": []},
        customer_account_id="123456789012",
    )
    statement = merged["Statement"][0]
    assert statement["Sid"] == "ChatticusCustomerAccountPull"
    assert statement["Action"] == sorted(ECR_PULL_ACTIONS)
    assert statement["Principal"] == {
        "AWS": [customer_account_ecr_pull_principal("123456789012")]
    }


def test_grant_customer_account_anthus_computer_image_pull() -> None:
    recorder = _RecordingEcrRepositoryPolicy()
    grant_customer_account_anthus_computer_image_pull(
        recorder,
        repository_name="chatticuscomputers-computerimage",
        customer_account_id="123456789012",
    )
    assert recorder.repository_name == "chatticuscomputers-computerimage"
    assert recorder.policy_text is not None
    policy = json.loads(recorder.policy_text)
    actions = policy["Statement"][0]["Action"]
    assert actions == sorted(ECR_PULL_ACTIONS)
