"""Behave steps for customer cross-account self-setup provisioning."""

from __future__ import annotations

from datetime import UTC, datetime

from behave import given, then, when

from chatticus.computer_start import HostStartClaim
from chatticus.control_plane import ControlPlane
from chatticus.cross_account_provisioning import (
    PROVISIONING_REQUIRED_PERMISSIONS,
    CrossAccountRoleSnapshot,
    InMemoryCrossAccountRoleInspector,
)
from chatticus.deployment_aws_account import DEFAULT_DEPLOYMENT_AWS_ACCOUNT_ID
from chatticus.messaging.store import InMemoryMessagingStore
from chatticus.models import AwsSetupPath, OrganizationStatus
from chatticus.organization_computer_host import (
    OrganizationComputerHostStarter,
    OrganizationComputerProvisioningError,
)

CUSTOMER_ACCOUNT_ID = "123456789012"
DEPLOYMENT_ACCOUNT_ID = DEFAULT_DEPLOYMENT_AWS_ACCOUNT_ID
CUSTOMER_ROLE_ARN = (
    f"arn:aws:iam::{CUSTOMER_ACCOUNT_ID}:role/ChatticusOrganizationComputerRole"
)
MISMATCHED_EXTERNAL_ID = "wrong-organization-id"
MISSING_PERMISSION = PROVISIONING_REQUIRED_PERMISSIONS[0]
NOW = datetime(2026, 8, 31, 12, 0, 0, tzinfo=UTC)


def _plane(context: object) -> ControlPlane:
    return context.plane


def _ensure_org_store(context: object) -> None:
    if not getattr(context, "plane", None):
        context.plane = ControlPlane(messaging_store=InMemoryMessagingStore())
    context.orgs_by_name = getattr(context, "orgs_by_name", {}) or {}
    context.identities_by_email = getattr(context, "identities_by_email", {}) or {}
    context.now = getattr(context, "now", NOW)
    _plane(context).set_now(context.now)


def _create_pending_customer_org(context: object) -> None:
    _ensure_org_store(context)
    identity = _plane(context).sign_in("owner@example.com", now=context.now)
    context.customer_org = _plane(context).create_organization(
        identity,
        "Acme",
        now=context.now,
    )
    context.aws_account_id = CUSTOMER_ACCOUNT_ID
    context.aws_role_arn = CUSTOMER_ROLE_ARN


def _set_role_inspector(
    context: object,
    *,
    trusted_external_id: str,
    granted_permissions: frozenset[str],
) -> None:
    snapshot = CrossAccountRoleSnapshot(
        account_id=context.aws_account_id,
        role_arn=context.aws_role_arn,
        trusted_external_id=trusted_external_id,
        granted_permissions=granted_permissions,
    )
    context.role_inspector = InMemoryCrossAccountRoleInspector(
        {(context.aws_account_id, context.aws_role_arn): snapshot}
    )


@given("a customer who has run the cross-account template in their own account")
def given_customer_ran_template(context: object) -> None:
    _create_pending_customer_org(context)
    _set_role_inspector(
        context,
        trusted_external_id=context.customer_org.tenant_id,
        granted_permissions=frozenset(PROVISIONING_REQUIRED_PERMISSIONS),
    )


@given("a customer whose role trusts a different ExternalId")
def given_role_trusts_different_external_id(context: object) -> None:
    _create_pending_customer_org(context)
    _set_role_inspector(
        context,
        trusted_external_id=MISMATCHED_EXTERNAL_ID,
        granted_permissions=frozenset(PROVISIONING_REQUIRED_PERMISSIONS),
    )


@given("a customer whose role lacks a permission provisioning needs")
def given_role_lacks_permission(context: object) -> None:
    _create_pending_customer_org(context)
    granted_permissions = frozenset(
        permission
        for permission in PROVISIONING_REQUIRED_PERMISSIONS
        if permission != MISSING_PERMISSION
    )
    _set_role_inspector(
        context,
        trusted_external_id=context.customer_org.tenant_id,
        granted_permissions=granted_permissions,
    )


@when("they submit their AWS account id and role")
def when_submit_account_and_role(context: object) -> None:
    context.self_setup_result = _plane(context).submit_self_setup_cross_account_role(
        context.customer_org.tenant_id,
        account_id=context.aws_account_id,
        cross_account_role=context.aws_role_arn,
        role_inspector=context.role_inspector,
    )


@then("provisioning proceeds without an assisted session")
def then_provisioning_without_assisted_session(context: object) -> None:
    result = context.self_setup_result
    assert result.accepted is True, result.message
    organization = result.organization
    assert organization.status == OrganizationStatus.ENABLED
    assert organization.aws_setup_path == AwsSetupPath.CUSTOMER_OWNED
    assert organization.assisted_setup_session is False


@then("no setup fee is charged")
def then_no_setup_fee_charged(context: object) -> None:
    organization = context.self_setup_result.organization
    assert organization.setup_fee_cents == 0


@then("the response names the ExternalId mismatch and how to correct it")
def then_response_names_external_id_mismatch(context: object) -> None:
    result = context.self_setup_result
    assert result.accepted is False
    message = result.message or ""
    lowered = message.lower()
    assert "externalid" in lowered.replace(" ", ""), message
    assert MISMATCHED_EXTERNAL_ID in message, message
    assert context.customer_org.tenant_id in message, message
    assert "cloudformation" in lowered, message
    assert "organizationid" in lowered.replace(" ", ""), message


@then("the response names the missing permission")
def then_response_names_missing_permission(context: object) -> None:
    result = context.self_setup_result
    assert result.accepted is False
    message = result.message or ""
    assert MISSING_PERMISSION in message, message


@then("the organization stays pending")
def then_organization_stays_pending(context: object) -> None:
    organization = context.self_setup_result.organization
    assert organization.status == OrganizationStatus.PENDING
    assert organization.aws_account_id is None
    assert organization.aws_cross_account_role is None


@given("an organization that has completed provisioning")
def given_completed_provisioning(context: object) -> None:
    _ensure_org_store(context)
    identity = _plane(context).sign_in("owner@example.com", now=context.now)
    org = _plane(context).create_organization(identity, "Test Org", now=context.now)
    _plane(context).enable_organization(org.tenant_id)
    context.provisioned_org = _plane(context).provision_organization_aws(
        org.tenant_id,
        account_id=CUSTOMER_ACCOUNT_ID,
        cross_account_role=CUSTOMER_ROLE_ARN,
        external_id=org.tenant_id,
        setup_path=AwsSetupPath.CUSTOMER_OWNED,
    )


@then("it records the customer AWS account id")
def then_records_customer_aws_account(context: object) -> None:
    org = context.provisioned_org
    assert org.aws_account_id == CUSTOMER_ACCOUNT_ID


@then("it records the cross-account role")
def then_records_cross_account_role(context: object) -> None:
    org = context.provisioned_org
    assert org.aws_cross_account_role == CUSTOMER_ROLE_ARN
    assert org.aws_external_id == org.tenant_id


@then("it records whether the account is customer-owned or Anthus-managed")
def then_records_setup_path(context: object) -> None:
    org = context.provisioned_org
    assert org.aws_setup_path == AwsSetupPath.CUSTOMER_OWNED


@given("an organization that has paid but not been provisioned")
def given_paid_not_provisioned(context: object) -> None:
    _ensure_org_store(context)
    identity = _plane(context).sign_in("newowner@example.com", now=context.now)
    context.pending_org = _plane(context).create_organization(
        identity,
        "Pending Org",
        now=context.now,
    )


@then("it records no customer AWS account")
def then_records_no_aws_account(context: object) -> None:
    org = context.pending_org
    assert org.aws_account_id is None
    assert org.aws_cross_account_role is None
    assert org.aws_external_id is None
    assert org.aws_setup_path is None


@then("its status is pending")
def then_status_is_pending(context: object) -> None:
    org = context.pending_org
    assert org.status == OrganizationStatus.PENDING


class RecordingAssumeRole:
    """Capture AssumeRole keyword arguments for scenario assertions."""

    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def __call__(self, **kwargs: object) -> dict[str, object]:
        self.calls.append(kwargs)
        return {
            "Credentials": {
                "AccessKeyId": "AKIATEST",
                "SecretAccessKey": "secret",
                "SessionToken": "token",
                "Expiration": NOW,
            }
        }


def _provision_cross_account_org(
    context: object,
    *,
    name: str,
    owner_email: str,
    account_id: str,
    external_id: str,
) -> object:
    _ensure_org_store(context)
    owner = _plane(context).sign_in(owner_email, now=context.now)
    org = _plane(context).create_organization(owner, name, now=context.now)
    _plane(context).enable_organization(org.tenant_id)
    role_arn = f"arn:aws:iam::{account_id}:role/ChatticusOrganizationComputerRole"
    return _plane(context).provision_organization_aws(
        org.tenant_id,
        account_id=account_id,
        cross_account_role=role_arn,
        external_id=external_id,
        setup_path=AwsSetupPath.CUSTOMER_OWNED,
    )


@given("an organization with a provisioned cross-account role")
def given_organization_with_provisioned_role(context: object) -> None:
    org = _provision_cross_account_org(
        context,
        name="Provisioned Org",
        owner_email="assume-owner@example.com",
        account_id="111111111111",
        external_id="external-id-alpha",
    )
    context.cross_account_org = org
    context.assume_role_recorder = RecordingAssumeRole()


@given("two organizations with cross-account roles in different AWS accounts")
def given_two_organizations_with_roles(context: object) -> None:
    context.first_cross_account_org = _provision_cross_account_org(
        context,
        name="First Org",
        owner_email="first@example.com",
        account_id="111111111111",
        external_id="external-id-alpha",
    )
    context.second_cross_account_org = _provision_cross_account_org(
        context,
        name="Second Org",
        owner_email="second@example.com",
        account_id="222222222222",
        external_id="external-id-beta",
    )
    context.assume_role_recorder = RecordingAssumeRole()


@when("Chatticus assumes that role")
def when_chatticus_assumes_role(context: object) -> None:
    org = context.cross_account_org
    context.assume_role_outcome = _plane(
        context
    ).assume_organization_cross_account_role(
        org.tenant_id,
        assume_role=context.assume_role_recorder,
    )


@when(
    "Chatticus attempts the first organization role using the second "
    "organization ExternalId"
)
def when_chatticus_attempts_role_with_wrong_external_id(context: object) -> None:
    first = context.first_cross_account_org
    second = context.second_cross_account_org
    context.assume_role_outcome = _plane(
        context
    ).assume_organization_cross_account_role(
        first.tenant_id,
        external_id=second.aws_external_id,
        assume_role=context.assume_role_recorder,
    )


@then("the request carries the ExternalId recorded for that organization")
def then_request_carries_recorded_external_id(context: object) -> None:
    org = context.cross_account_org
    recorder = context.assume_role_recorder
    assert len(recorder.calls) == 1
    assert recorder.calls[0]["ExternalId"] == org.aws_external_id
    outcome = context.assume_role_outcome
    assert outcome.refused is False
    assert outcome.external_id == org.aws_external_id
    assert outcome.session is not None


@then("the assume is refused")
def then_assume_is_refused(context: object) -> None:
    assert context.assume_role_outcome.refused is True


@then("no session is issued")
def then_no_session_is_issued(context: object) -> None:
    outcome = context.assume_role_outcome
    assert outcome.session is None
    assert len(context.assume_role_recorder.calls) == 0


class _FakeEcs:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def run_task(self, **kwargs: object) -> dict[str, object]:
        self.calls.append(kwargs)
        return {"tasks": [{"taskArn": "arn:ecs:task/gherkin"}], "failures": []}


class _FakeCloudFormation:
    def __init__(self) -> None:
        self.describe_calls: list[dict[str, object]] = []

    def describe_stacks(self, **kwargs: object) -> dict[str, object]:
        self.describe_calls.append(kwargs)
        return {
            "Stacks": [
                {
                    "Outputs": [
                        {
                            "OutputKey": "ComputerClusterName",
                            "OutputValue": "cust-cluster",
                        },
                        {
                            "OutputKey": "ComputerTaskDefinitionArn",
                            "OutputValue": (
                                "arn:aws:ecs:us-east-1:123456789012:"
                                "task-definition/computer:1"
                            ),
                        },
                        {
                            "OutputKey": "ComputerServiceName",
                            "OutputValue": "FargateHost",
                        },
                    ]
                }
            ]
        }


class _FakeEcsWithServices(_FakeEcs):
    def describe_services(
        self,
        *,
        cluster: str,
        services: list[str],
    ) -> dict[str, object]:
        return {
            "services": [
                {
                    "networkConfiguration": {
                        "awsvpcConfiguration": {
                            "subnets": ["subnet-customer-1"],
                            "securityGroups": ["sg-customer-1"],
                        }
                    }
                }
            ]
        }


class _MultiAccountEcsRecorder:
    def __init__(self) -> None:
        self.deployment = _FakeEcs()
        self.customer = _FakeEcsWithServices()

    def factory(self, credentials: dict[str, str] | None) -> _FakeEcs:
        if credentials is None:
            return self.deployment
        return self.customer


def _host_starter(context: object) -> OrganizationComputerHostStarter:
    return context.host_starter  # type: ignore[attr-defined]


def _start_claim_for_org(context: object, tenant_id: str) -> HostStartClaim:
    plane = _plane(context)
    plane.ensure_computer(tenant_id)
    computer = plane.computer_for_organization(tenant_id)
    return HostStartClaim(
        tenant_id=tenant_id,
        computer_id=computer.computer_id,
        host_start_count=1,
        user_id="owner-user",
    )


def _wire_host_start_context(
    context: object,
    *,
    assume_role: object | None = None,
) -> None:
    _ensure_org_store(context)
    recorder = _MultiAccountEcsRecorder()
    context.ecs_recorder = recorder  # type: ignore[attr-defined]
    context.host_starter = OrganizationComputerHostStarter(  # type: ignore[attr-defined]
        _plane(context).get_organization,
        deployment_account_id=DEPLOYMENT_ACCOUNT_ID,
        assume_role=assume_role or RecordingAssumeRole(),
        ecs_client_factory=recorder.factory,
        cloudformation_client_factory=lambda _credentials: _FakeCloudFormation(),
    )
    context.host_start_error = None  # type: ignore[attr-defined]


@given("an organization provisioned into a customer AWS account")
def given_organization_provisioned_into_customer_account(context: object) -> None:
    org = _provision_cross_account_org(
        context,
        name="Customer Org",
        owner_email="customer-start@example.com",
        account_id=CUSTOMER_ACCOUNT_ID,
        external_id="customer-org-external-id",
    )
    context.start_org = org
    _wire_host_start_context(context)


@given("its customer account has a ChatticusComputers stack")
def given_customer_account_has_computers_stack(context: object) -> None:
    assert context.start_org.aws_account_id == CUSTOMER_ACCOUNT_ID


@given("an organization whose cross-account role cannot be assumed")
def given_unreachable_customer_role(context: object) -> None:
    org = _provision_cross_account_org(
        context,
        name="Unreachable Org",
        owner_email="unreachable@example.com",
        account_id=CUSTOMER_ACCOUNT_ID,
        external_id="unreachable-external-id",
    )
    context.start_org = org

    class _UnreachableAssumeRole:
        def __call__(self, **_kwargs: object) -> dict[str, object]:
            raise RuntimeError("AssumeRole refused by STS")

    _wire_host_start_context(context, assume_role=_UnreachableAssumeRole())


@when("its computer starts")
@when("its computer is asked to start")
def when_its_computer_starts(context: object) -> None:
    if not getattr(context, "host_starter", None):
        _wire_host_start_context(context)
    org = getattr(context, "start_org", None) or context.pending_org
    claim = _start_claim_for_org(context, org.tenant_id)
    starter = _host_starter(context)
    try:
        starter.start_host(claim)
    except OrganizationComputerProvisioningError as error:
        context.host_start_error = error  # type: ignore[attr-defined]


@then("the instance is launched in the customer account")
def then_instance_launched_in_customer_account(context: object) -> None:
    starter = _host_starter(context)
    assert starter.last_outcome is not None
    assert starter.last_outcome.launch_account_id == CUSTOMER_ACCOUNT_ID
    assert len(context.ecs_recorder.customer.calls) == 1  # type: ignore[attr-defined]


@then("no compute for that organization runs in the Anthus account")
@then("no instance is launched in the Anthus account")
def then_no_compute_in_deployment_account(context: object) -> None:
    recorder = getattr(context, "ecs_recorder", None)
    if recorder is not None:
        assert len(recorder.deployment.calls) == 0
        return
    assert context.host_start_error is not None  # type: ignore[attr-defined]


@then("the start is refused with a provisioning error")
def then_start_refused_with_provisioning_error(context: object) -> None:
    error = context.host_start_error  # type: ignore[attr-defined]
    assert error is not None
    assert "provisioning" in str(error).lower()
