"""Cross-account role validation for customer self-setup."""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Protocol

import boto3
from botocore.exceptions import ClientError

from chatticus.models import (
    ASSISTED_SETUP_FEE_CENTS,
    AwsSetupPath,
    ChatticusError,
    Organization,
    OrganizationStatus,
    SelfSetupCrossAccountResult,
)

PROVISIONING_REQUIRED_PERMISSIONS: tuple[str, ...] = (
    "cloudformation:CreateStack",
    "cloudformation:UpdateStack",
    "cloudformation:DeleteStack",
    "cloudformation:DescribeStacks",
    "ecs:CreateCluster",
    "ecs:RunTask",
    "ec2:CreateVpc",
    "ecr:GetAuthorizationToken",
    "logs:CreateLogGroup",
    "iam:PassRole",
)


class CrossAccountRoleInspectionError(ChatticusError):
    """Live cross-account role inspection failed before validation could finish."""


AssumeRoleCallable = Callable[..., Mapping[str, Any]]
ListRolePoliciesCallable = Callable[..., Mapping[str, Any]]
GetRolePolicyCallable = Callable[..., Mapping[str, Any]]


@dataclass(frozen=True)
class CrossAccountRoleSnapshot:
    """Trust and permission view of one customer cross-account role."""

    account_id: str
    role_arn: str
    trusted_external_id: str | None
    granted_permissions: frozenset[str]


class CrossAccountRoleInspector(Protocol):
    """Inspect one customer cross-account role before provisioning."""

    def inspect_role(
        self,
        account_id: str,
        role_arn: str,
        *,
        expected_external_id: str,
    ) -> CrossAccountRoleSnapshot:
        """Return trust and permission details for *role_arn*."""


@dataclass(frozen=True)
class InMemoryCrossAccountRoleInspector:
    """Deterministic role inspector for Gherkin and kernel tests."""

    snapshots: Mapping[tuple[str, str], CrossAccountRoleSnapshot]

    def inspect_role(
        self,
        account_id: str,
        role_arn: str,
        *,
        expected_external_id: str,
    ) -> CrossAccountRoleSnapshot:
        """Return the configured snapshot for one account and role pair."""
        _ = expected_external_id
        key = (account_id, role_arn)
        snapshot = self.snapshots.get(key)
        if snapshot is None:
            raise KeyError(f"No cross-account role snapshot configured for {key!r}.")
        return snapshot


def _role_name_from_arn(role_arn: str) -> str:
    """Return the IAM role name embedded in *role_arn*."""
    return role_arn.rsplit("/", maxsplit=1)[-1]


def _assume_role_failed_message(expected_external_id: str) -> str:
    """Return the customer-facing message when AssumeRole fails during inspect."""
    return (
        f"The cross-account role could not be assumed with ExternalId "
        f"{expected_external_id!r}. Re-run the Chatticus cross-account "
        "CloudFormation template with OrganizationId set to your Chatticus "
        "organization id."
    )


def _policy_read_failed_message() -> str:
    """Return the customer-facing message when role policy reads fail."""
    return (
        "The cross-account role could not be inspected. Re-run the published "
        "Chatticus cross-account template in your AWS account."
    )


def _iam_actions_from_policy_document(document: object) -> frozenset[str]:
    """Collect Allow actions from one IAM policy document."""
    if isinstance(document, str):
        try:
            parsed = json.loads(document)
        except json.JSONDecodeError:
            return frozenset()
    elif isinstance(document, dict):
        parsed = document
    else:
        return frozenset()
    statements = parsed.get("Statement", [])
    if isinstance(statements, dict):
        statements = [statements]
    actions: set[str] = set()
    for statement in statements:
        if not isinstance(statement, dict):
            continue
        if statement.get("Effect") != "Allow":
            continue
        action = statement.get("Action")
        if isinstance(action, str):
            actions.add(action)
        elif isinstance(action, list):
            actions.update(item for item in action if isinstance(item, str))
    return frozenset(actions)


def _granted_permissions_from_role_policies(
    role_arn: str,
    *,
    list_role_policies: ListRolePoliciesCallable,
    get_role_policy: GetRolePolicyCallable,
) -> frozenset[str]:
    """Read inline role policies using assumed-role credentials."""
    role_name = _role_name_from_arn(role_arn)
    granted: set[str] = set()
    inline_names = list_role_policies(RoleName=role_name).get("PolicyNames", [])
    for policy_name in inline_names:
        if not isinstance(policy_name, str):
            continue
        response = get_role_policy(RoleName=role_name, PolicyName=policy_name)
        granted.update(
            _iam_actions_from_policy_document(response.get("PolicyDocument", {}))
        )
    return frozenset(granted)


@dataclass(frozen=True)
class AwsCrossAccountRoleInspector:
    """Live role inspector using STS AssumeRole and IAM policy reads."""

    assume_role: AssumeRoleCallable | None = None
    list_role_policies: ListRolePoliciesCallable | None = None
    get_role_policy: GetRolePolicyCallable | None = None

    def inspect_role(
        self,
        account_id: str,
        role_arn: str,
        *,
        expected_external_id: str,
    ) -> CrossAccountRoleSnapshot:
        """Assume the customer role and read its IAM policies for permissions."""
        assume_role = self.assume_role or boto3.client("sts").assume_role
        try:
            response = assume_role(
                RoleArn=role_arn,
                RoleSessionName=f"chatticus-inspect-{account_id}",
                ExternalId=expected_external_id,
            )
        except ClientError as error:
            raise CrossAccountRoleInspectionError(
                _assume_role_failed_message(expected_external_id)
            ) from error
        credentials = response["Credentials"]
        session = boto3.Session(
            aws_access_key_id=str(credentials["AccessKeyId"]),
            aws_secret_access_key=str(credentials["SecretAccessKey"]),
            aws_session_token=str(credentials["SessionToken"]),
        )
        iam = session.client("iam")
        list_role_policies = self.list_role_policies or iam.list_role_policies
        get_role_policy = self.get_role_policy or iam.get_role_policy
        try:
            granted_permissions = _granted_permissions_from_role_policies(
                role_arn,
                list_role_policies=list_role_policies,
                get_role_policy=get_role_policy,
            )
        except ClientError as error:
            raise CrossAccountRoleInspectionError(
                _policy_read_failed_message()
            ) from error
        return CrossAccountRoleSnapshot(
            account_id=account_id,
            role_arn=role_arn,
            trusted_external_id=expected_external_id,
            granted_permissions=granted_permissions,
        )


def account_id_from_role_arn(role_arn: str) -> str | None:
    """Return the 12-digit account id embedded in *role_arn*, if present."""
    prefix = "arn:aws:iam::"
    if not role_arn.startswith(prefix):
        return None
    remainder = role_arn[len(prefix) :]
    account_id, separator, _role = remainder.partition(":")
    if separator != ":" or len(account_id) != 12 or not account_id.isdigit():
        return None
    return account_id


def validate_cross_account_role_for_self_setup(
    organization: Organization,
    *,
    account_id: str,
    cross_account_role: str,
    role_inspector: CrossAccountRoleInspector,
) -> SelfSetupCrossAccountResult:
    """Validate one customer role submission and return an acceptance decision."""
    role_account_id = account_id_from_role_arn(cross_account_role)
    if role_account_id is None:
        return SelfSetupCrossAccountResult(
            accepted=False,
            organization=organization,
            message=(
                "The role ARN is not a valid IAM role ARN. Copy the RoleArn "
                "output from the Chatticus cross-account CloudFormation stack."
            ),
        )
    if role_account_id != account_id:
        return SelfSetupCrossAccountResult(
            accepted=False,
            organization=organization,
            message=(
                f"The role ARN belongs to account {role_account_id}, but "
                f"{account_id} was submitted. Use the AWS account id where "
                "you ran the Chatticus cross-account template."
            ),
        )

    try:
        snapshot = role_inspector.inspect_role(
            account_id,
            cross_account_role,
            expected_external_id=organization.tenant_id,
        )
    except CrossAccountRoleInspectionError as error:
        return SelfSetupCrossAccountResult(
            accepted=False,
            organization=organization,
            message=str(error),
        )
    expected_external_id = organization.tenant_id
    if snapshot.trusted_external_id != expected_external_id:
        trusted = snapshot.trusted_external_id
        return SelfSetupCrossAccountResult(
            accepted=False,
            organization=organization,
            message=(
                f"The role trusts ExternalId {trusted!r}, but this organization "
                f"requires {expected_external_id!r}. Re-run the Chatticus "
                "cross-account CloudFormation template with OrganizationId set "
                "to your Chatticus organization id."
            ),
        )

    missing_permission = next(
        (
            permission
            for permission in PROVISIONING_REQUIRED_PERMISSIONS
            if permission not in snapshot.granted_permissions
        ),
        None,
    )
    if missing_permission is not None:
        return SelfSetupCrossAccountResult(
            accepted=False,
            organization=organization,
            message=(
                f"The role is missing {missing_permission}, which "
                "cross-account provisioning requires. Re-run the published "
                "Chatticus cross-account template in your AWS account."
            ),
        )

    if organization.status != OrganizationStatus.PENDING:
        return SelfSetupCrossAccountResult(
            accepted=False,
            organization=organization,
            message=(
                f"Organization {organization.tenant_id!r} has status "
                f"{organization.status!r}; self-setup requires pending."
            ),
        )

    return SelfSetupCrossAccountResult(
        accepted=True,
        organization=organization,
        message=None,
    )


def organization_after_accepted_self_setup(
    organization: Organization,
    *,
    account_id: str,
    cross_account_role: str,
) -> Organization:
    """Return one organization updated after accepted self-setup validation."""
    from dataclasses import replace

    provisioned = replace(
        organization,
        aws_account_id=account_id,
        aws_cross_account_role=cross_account_role,
        aws_external_id=organization.tenant_id,
        aws_setup_path=AwsSetupPath.CUSTOMER_OWNED,
        setup_fee_cents=0,
        assisted_setup_session=False,
        status=OrganizationStatus.ENABLED,
    )
    return provisioned


def organization_after_assisted_setup(
    organization: Organization,
    *,
    account_id: str,
    cross_account_role: str,
) -> Organization:
    """Return one organization updated after an Anthus-assisted setup session."""
    from dataclasses import replace

    return replace(
        organization,
        aws_account_id=account_id,
        aws_cross_account_role=cross_account_role,
        aws_external_id=organization.tenant_id,
        aws_setup_path=AwsSetupPath.ANTHUS_MANAGED,
        setup_fee_cents=ASSISTED_SETUP_FEE_CENTS,
        assisted_setup_session=True,
        status=OrganizationStatus.ENABLED,
    )
