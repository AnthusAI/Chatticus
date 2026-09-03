"""Cross-account role validation for customer self-setup."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol

from chatticus.models import (
    ASSISTED_SETUP_FEE_CENTS,
    AwsSetupPath,
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


@dataclass(frozen=True)
class CrossAccountRoleSnapshot:
    """Trust and permission view of one customer cross-account role."""

    account_id: str
    role_arn: str
    trusted_external_id: str | None
    granted_permissions: frozenset[str]


class CrossAccountRoleInspector(Protocol):
    """Inspect one customer cross-account role before provisioning."""

    def inspect_role(self, account_id: str, role_arn: str) -> CrossAccountRoleSnapshot:
        """Return trust and permission details for *role_arn*."""


@dataclass(frozen=True)
class InMemoryCrossAccountRoleInspector:
    """Deterministic role inspector for Gherkin and kernel tests."""

    snapshots: Mapping[tuple[str, str], CrossAccountRoleSnapshot]

    def inspect_role(self, account_id: str, role_arn: str) -> CrossAccountRoleSnapshot:
        """Return the configured snapshot for one account and role pair."""
        key = (account_id, role_arn)
        snapshot = self.snapshots.get(key)
        if snapshot is None:
            raise KeyError(f"No cross-account role snapshot configured for {key!r}.")
        return snapshot


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

    snapshot = role_inspector.inspect_role(account_id, cross_account_role)
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
