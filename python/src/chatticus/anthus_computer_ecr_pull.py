"""Grant Anthus ECR pull to one customer AWS account."""

from __future__ import annotations

import json
from typing import Any, Protocol

ECR_PULL_ACTIONS = (
    "ecr:BatchGetImage",
    "ecr:GetDownloadUrlForLayer",
)


class EcrRepositoryPolicyClient(Protocol):
    """Subset of ECR client methods used to merge repository policies."""

    def get_repository_policy(self, *, repositoryName: str) -> dict[str, Any]:
        """Return the repository policy document for *repositoryName*."""

    def set_repository_policy(
        self,
        *,
        repositoryName: str,
        policyText: str,
    ) -> dict[str, Any]:
        """Replace the repository policy document for *repositoryName*."""


def customer_account_ecr_pull_principal(customer_account_id: str) -> str:
    """Return the account-root principal ARN for one customer account."""
    return f"arn:aws:iam::{customer_account_id}:root"


def merge_customer_account_ecr_pull_statement(
    policy_document: dict[str, Any],
    *,
    customer_account_id: str,
) -> dict[str, Any]:
    """Return *policy_document* with pull access for one customer account."""
    principal = customer_account_ecr_pull_principal(customer_account_id)
    statements = list(policy_document.get("Statement") or [])
    for statement in statements:
        if not isinstance(statement, dict):
            continue
        if statement.get("Sid") != "ChatticusCustomerAccountPull":
            continue
        principals = _principal_list(statement.get("Principal"))
        if principal not in principals:
            principals.append(principal)
            statement["Principal"] = {"AWS": principals}
        actions = set(_action_list(statement.get("Action")))
        actions.update(ECR_PULL_ACTIONS)
        statement["Action"] = sorted(actions)
        return policy_document

    statements.append(
        {
            "Sid": "ChatticusCustomerAccountPull",
            "Effect": "Allow",
            "Principal": {"AWS": [principal]},
            "Action": list(ECR_PULL_ACTIONS),
        }
    )
    return {
        "Version": policy_document.get("Version") or "2012-10-17",
        "Statement": statements,
    }


def grant_customer_account_anthus_computer_image_pull(
    ecr_client: EcrRepositoryPolicyClient,
    *,
    repository_name: str,
    customer_account_id: str,
) -> None:
    """Merge one customer account into the Anthus computer image repository policy."""
    try:
        response = ecr_client.get_repository_policy(repositoryName=repository_name)
    except Exception as error:
        error_code = getattr(error, "response", {}).get("Error", {}).get("Code")
        if error_code == "RepositoryPolicyNotFoundException":
            policy_document: dict[str, Any] = {"Version": "2012-10-17", "Statement": []}
        else:
            raise
    else:
        policy_text = response.get("policyText") or "{}"
        policy_document = json.loads(policy_text)
        if not isinstance(policy_document, dict):
            raise ValueError(
                "Anthus computer ECR repository policy must be a JSON object."
            )

    merged = merge_customer_account_ecr_pull_statement(
        policy_document,
        customer_account_id=customer_account_id,
    )
    ecr_client.set_repository_policy(
        repositoryName=repository_name,
        policyText=json.dumps(merged, separators=(",", ":")),
    )


def _principal_list(raw: object) -> list[str]:
    if isinstance(raw, str):
        return [raw]
    if isinstance(raw, dict):
        aws = raw.get("AWS")
        if isinstance(aws, str):
            return [aws]
        if isinstance(aws, list):
            return [str(item) for item in aws]
    return []


def _action_list(raw: object) -> list[str]:
    if isinstance(raw, str):
        return [raw]
    if isinstance(raw, list):
        return [str(item) for item in raw]
    return []
