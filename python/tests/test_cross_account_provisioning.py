"""Unit tests for live cross-account role inspection."""

from __future__ import annotations

from chatticus.cross_account_provisioning import (
    PROVISIONING_REQUIRED_PERMISSIONS,
    AwsCrossAccountRoleInspector,
)


def test_aws_inspector_returns_permissions_after_successful_assume_role() -> None:
    def assume_role(**kwargs: object) -> dict[str, object]:
        assert kwargs["ExternalId"] == "tenant-alpha"
        return {
            "Credentials": {
                "AccessKeyId": "AKIA",
                "SecretAccessKey": "secret",
                "SessionToken": "token",
            }
        }

    def simulate_principal_policy(**kwargs: object) -> dict[str, object]:
        actions = kwargs["ActionNames"]
        return {"EvaluationResults": [{"EvalDecision": "allowed"} for _ in actions]}

    inspector = AwsCrossAccountRoleInspector(
        assume_role=assume_role,
        simulate_principal_policy=simulate_principal_policy,
    )
    snapshot = inspector.inspect_role(
        "123456789012",
        "arn:aws:iam::123456789012:role/ChatticusOrganizationComputerRole",
        expected_external_id="tenant-alpha",
    )
    assert snapshot.trusted_external_id == "tenant-alpha"
    assert snapshot.granted_permissions == frozenset(PROVISIONING_REQUIRED_PERMISSIONS)


def test_aws_inspector_reads_trusted_external_id_when_assume_role_fails() -> None:
    def assume_role(**kwargs: object) -> dict[str, object]:
        raise _client_error("AccessDenied")

    def get_role(**kwargs: object) -> dict[str, object]:
        return {
            "Role": {
                "AssumeRolePolicyDocument": (
                    '{"Statement":[{"Effect":"Allow","Condition":{"StringEquals":'
                    '{"sts:ExternalId":"wrong-id"}}}]}'
                )
            }
        }

    inspector = AwsCrossAccountRoleInspector(
        assume_role=assume_role,
        get_role=get_role,
    )
    snapshot = inspector.inspect_role(
        "123456789012",
        "arn:aws:iam::123456789012:role/ChatticusOrganizationComputerRole",
        expected_external_id="tenant-alpha",
    )
    assert snapshot.trusted_external_id == "wrong-id"
    assert snapshot.granted_permissions == frozenset()


def _client_error(code: str) -> Exception:
    from botocore.exceptions import ClientError

    return ClientError({"Error": {"Code": code, "Message": code}}, "AssumeRole")
