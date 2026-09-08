"""Unit tests for live cross-account role inspection."""

from __future__ import annotations

from chatticus.cross_account_provisioning import (
    PROVISIONING_REQUIRED_PERMISSIONS,
    AwsCrossAccountRoleInspector,
    CrossAccountRoleInspectionError,
    InMemoryCrossAccountRoleInspector,
    _iam_actions_from_policy_document,
    validate_cross_account_role_for_self_setup,
)
from chatticus.messaging.store import InMemoryMessagingStore
from chatticus.models import OrganizationStatus
from chatticus.org_records import OrgRecordsKernel

ROLE_ARN = "arn:aws:iam::123456789012:role/ChatticusOrganizationComputerRole"
ACCOUNT_ID = "123456789012"
TENANT_ID = "tenant-alpha"


def _published_template_inline_policy() -> dict[str, object]:
    return {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Action": list(PROVISIONING_REQUIRED_PERMISSIONS),
                "Resource": "*",
            }
        ],
    }


def _inspector_with_inline_policy(
    policy_document: dict[str, object],
) -> AwsCrossAccountRoleInspector:
    def assume_role(**kwargs: object) -> dict[str, object]:
        assert kwargs["ExternalId"] == TENANT_ID
        return {
            "Credentials": {
                "AccessKeyId": "AKIA",
                "SecretAccessKey": "secret",
                "SessionToken": "token",
            }
        }

    def list_role_policies(**kwargs: object) -> dict[str, object]:
        assert kwargs["RoleName"] == "ChatticusOrganizationComputerRole"
        return {"PolicyNames": ["ChatticusProvisioningAndOperation"]}

    def get_role_policy(**kwargs: object) -> dict[str, object]:
        assert kwargs["RoleName"] == "ChatticusOrganizationComputerRole"
        assert kwargs["PolicyName"] == "ChatticusProvisioningAndOperation"
        return {"PolicyDocument": policy_document}

    return AwsCrossAccountRoleInspector(
        assume_role=assume_role,
        list_role_policies=list_role_policies,
        get_role_policy=get_role_policy,
    )


def test_iam_actions_from_policy_document_reads_allow_actions() -> None:
    actions = _iam_actions_from_policy_document(_published_template_inline_policy())
    assert actions == frozenset(PROVISIONING_REQUIRED_PERMISSIONS)


def test_aws_inspector_reads_inline_policy_after_assume_role() -> None:
    inspector = _inspector_with_inline_policy(_published_template_inline_policy())
    snapshot = inspector.inspect_role(
        ACCOUNT_ID,
        ROLE_ARN,
        expected_external_id=TENANT_ID,
    )
    assert snapshot.trusted_external_id == TENANT_ID
    assert snapshot.granted_permissions == frozenset(PROVISIONING_REQUIRED_PERMISSIONS)


def test_aws_inspector_only_calls_inline_policy_apis() -> None:
    called: list[str] = []

    def assume_role(**kwargs: object) -> dict[str, object]:
        called.append("assume_role")
        return {
            "Credentials": {
                "AccessKeyId": "AKIA",
                "SecretAccessKey": "secret",
                "SessionToken": "token",
            }
        }

    def list_role_policies(**kwargs: object) -> dict[str, object]:
        called.append("list_role_policies")
        return {"PolicyNames": ["ChatticusProvisioningAndOperation"]}

    def get_role_policy(**kwargs: object) -> dict[str, object]:
        called.append("get_role_policy")
        return {"PolicyDocument": _published_template_inline_policy()}

    def simulate_principal_policy(**kwargs: object) -> dict[str, object]:
        called.append("simulate_principal_policy")
        raise AssertionError("SimulatePrincipalPolicy must not be called")

    def get_policy(**kwargs: object) -> dict[str, object]:
        called.append("get_policy")
        raise AssertionError("GetPolicy must not be called")

    def get_policy_version(**kwargs: object) -> dict[str, object]:
        called.append("get_policy_version")
        raise AssertionError("GetPolicyVersion must not be called")

    inspector = AwsCrossAccountRoleInspector(
        assume_role=assume_role,
        list_role_policies=list_role_policies,
        get_role_policy=get_role_policy,
    )
    assert not hasattr(inspector, "simulate_principal_policy")
    assert not hasattr(inspector, "get_policy")
    assert not hasattr(inspector, "get_policy_version")
    assert not hasattr(inspector, "list_attached_role_policies")
    inspector.inspect_role(
        ACCOUNT_ID,
        ROLE_ARN,
        expected_external_id=TENANT_ID,
    )
    assert called == [
        "assume_role",
        "list_role_policies",
        "get_role_policy",
    ]
    _ = (simulate_principal_policy, get_policy, get_policy_version)


def test_aws_inspector_reports_missing_permission_from_inline_policy() -> None:
    granted = list(PROVISIONING_REQUIRED_PERMISSIONS)
    missing = granted.pop()
    policy = {
        "Version": "2012-10-17",
        "Statement": [{"Effect": "Allow", "Action": granted, "Resource": "*"}],
    }
    inspector = _inspector_with_inline_policy(policy)
    snapshot = inspector.inspect_role(
        ACCOUNT_ID,
        ROLE_ARN,
        expected_external_id=TENANT_ID,
    )
    assert missing not in snapshot.granted_permissions


def test_aws_inspector_assume_role_failure_raises_inspection_error() -> None:
    def assume_role(**kwargs: object) -> dict[str, object]:
        raise _client_error("AccessDenied")

    inspector = AwsCrossAccountRoleInspector(assume_role=assume_role)
    try:
        inspector.inspect_role(
            ACCOUNT_ID,
            ROLE_ARN,
            expected_external_id=TENANT_ID,
        )
    except CrossAccountRoleInspectionError as error:
        message = str(error)
        assert TENANT_ID in message
        assert "OrganizationId" in message
        assert "CloudFormation" in message
    else:
        raise AssertionError("expected CrossAccountRoleInspectionError")


def test_validate_maps_assume_role_failure_to_rejected_result() -> None:
    kernel = OrgRecordsKernel(InMemoryMessagingStore())
    from datetime import UTC, datetime

    now = datetime(2026, 8, 31, 12, 0, 0, tzinfo=UTC)
    owner = kernel.sign_in("owner@example.com", now=now)
    organization = kernel.create_organization(owner, "Acme", now=now)

    def assume_role(**kwargs: object) -> dict[str, object]:
        raise _client_error("AccessDenied")

    inspector = AwsCrossAccountRoleInspector(assume_role=assume_role)
    result = validate_cross_account_role_for_self_setup(
        organization,
        account_id=ACCOUNT_ID,
        cross_account_role=ROLE_ARN,
        role_inspector=inspector,
    )
    assert result.accepted is False
    assert result.organization.status == OrganizationStatus.PENDING
    assert organization.tenant_id in (result.message or "")
    assert "OrganizationId" in (result.message or "")


def test_aws_inspector_policy_read_failure_raises_inspection_error() -> None:
    inspector = _inspector_with_inline_policy(_published_template_inline_policy())

    def failing_get_role_policy(**kwargs: object) -> dict[str, object]:
        raise _client_error("AccessDenied")

    inspector = AwsCrossAccountRoleInspector(
        assume_role=inspector.assume_role,
        list_role_policies=inspector.list_role_policies,
        get_role_policy=failing_get_role_policy,
    )
    try:
        inspector.inspect_role(
            ACCOUNT_ID,
            ROLE_ARN,
            expected_external_id=TENANT_ID,
        )
    except CrossAccountRoleInspectionError as error:
        assert "could not be inspected" in str(error)
    else:
        raise AssertionError("expected CrossAccountRoleInspectionError")


def test_in_memory_inspector_still_drives_external_id_mismatch_message() -> None:
    from chatticus.cross_account_provisioning import CrossAccountRoleSnapshot

    kernel = OrgRecordsKernel(InMemoryMessagingStore())
    from datetime import UTC, datetime

    now = datetime(2026, 8, 31, 12, 0, 0, tzinfo=UTC)
    owner = kernel.sign_in("owner@example.com", now=now)
    organization = kernel.create_organization(owner, "Acme", now=now)
    snapshot = CrossAccountRoleSnapshot(
        account_id=ACCOUNT_ID,
        role_arn=ROLE_ARN,
        trusted_external_id="wrong-organization-id",
        granted_permissions=frozenset(PROVISIONING_REQUIRED_PERMISSIONS),
    )
    inspector = InMemoryCrossAccountRoleInspector({(ACCOUNT_ID, ROLE_ARN): snapshot})
    result = validate_cross_account_role_for_self_setup(
        organization,
        account_id=ACCOUNT_ID,
        cross_account_role=ROLE_ARN,
        role_inspector=inspector,
    )
    assert result.accepted is False
    assert "wrong-organization-id" in (result.message or "")
    assert organization.tenant_id in (result.message or "")


def _client_error(code: str) -> Exception:
    from botocore.exceptions import ClientError

    return ClientError({"Error": {"Code": code, "Message": code}}, "AssumeRole")
