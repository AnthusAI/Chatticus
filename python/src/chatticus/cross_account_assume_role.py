"""Cross-account role assumption with per-organization ExternalId guard."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from chatticus.models import ChatticusError, Organization

AssumeRoleCallable = Callable[..., Mapping[str, Any]]


class OrganizationCrossAccountRoleMissingError(ChatticusError):
    """An organization has no recorded cross-account role to assume."""


@dataclass(frozen=True)
class CrossAccountRoleSession:
    """Temporary credentials from one successful AssumeRole call."""

    access_key_id: str
    secret_access_key: str
    session_token: str
    expiration: datetime


@dataclass(frozen=True)
class CrossAccountAssumeRoleOutcome:
    """Result of one cross-account AssumeRole attempt."""

    external_id: str | None
    session: CrossAccountRoleSession | None
    refused: bool


def attempt_cross_account_assume_role(
    organization: Organization,
    *,
    external_id: str | None = None,
    assume_role: AssumeRoleCallable,
) -> CrossAccountAssumeRoleOutcome:
    """Assume one organization's cross-account role with its ExternalId.

    When ``external_id`` is omitted, the value recorded on the organization
    is used. A mismatched ExternalId is refused before calling STS.
    """
    if (
        organization.aws_cross_account_role is None
        or organization.aws_external_id is None
    ):
        raise OrganizationCrossAccountRoleMissingError(
            f"Organization {organization.tenant_id!r} has no cross-account role."
        )
    presented_external_id = (
        external_id if external_id is not None else organization.aws_external_id
    )
    if presented_external_id != organization.aws_external_id:
        return CrossAccountAssumeRoleOutcome(
            external_id=presented_external_id,
            session=None,
            refused=True,
        )
    response = assume_role(
        RoleArn=organization.aws_cross_account_role,
        RoleSessionName=f"chatticus-{organization.tenant_id}",
        ExternalId=presented_external_id,
    )
    credentials = response["Credentials"]
    session = CrossAccountRoleSession(
        access_key_id=str(credentials["AccessKeyId"]),
        secret_access_key=str(credentials["SecretAccessKey"]),
        session_token=str(credentials["SessionToken"]),
        expiration=credentials["Expiration"],
    )
    return CrossAccountAssumeRoleOutcome(
        external_id=presented_external_id,
        session=session,
        refused=False,
    )
