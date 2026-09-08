"""Behave steps for customer cross-account self-setup provisioning."""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

from behave import given, then, when
from botocore.exceptions import ClientError

from chatticus.computer_start import HostStartClaim
from chatticus.control_plane import ControlPlane
from chatticus.cross_account_provisioning import (
    PROVISIONING_REQUIRED_PERMISSIONS,
    CrossAccountRoleSnapshot,
    InMemoryCrossAccountRoleInspector,
)
from chatticus.customer_computers_provision import (
    AwsCustomerComputersProvisioner,
    RefusingCustomerComputersProvisioner,
)
from chatticus.messaging.store import InMemoryMessagingStore
from chatticus.models import (
    AwsSetupPath,
    OrganizationComputerProvisioningError,
    OrganizationStatus,
)
from chatticus.organization_computer_host import (
    DeploymentEcsConfig,
    OrganizationComputerHostStarter,
)

CUSTOMER_ACCOUNT_ID = "123456789012"
DEPLOYMENT_ACCOUNT_ID = "111122223333"
CUSTOMER_COMPUTER_REPOSITORY_URI = (
    f"{CUSTOMER_ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com/"
    "chatticuscomputers-computerimage"
)
CUSTOMER_ROLE_ARN = (
    f"arn:aws:iam::{CUSTOMER_ACCOUNT_ID}:role/ChatticusOrganizationComputerRole"
)
MISMATCHED_EXTERNAL_ID = "wrong-organization-id"
MISSING_PERMISSION = PROVISIONING_REQUIRED_PERMISSIONS[0]
NOW = datetime(2026, 8, 31, 12, 0, 0, tzinfo=UTC)
DEFAULT_MONTHLY_AWS_SPEND_CEILING_USD = Decimal("250.00")


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
    organization = context.customer_org
    context.self_setup_result = _plane(context).submit_self_setup_cross_account_role(
        organization.tenant_id,
        actor_user_id=organization.owner_user_id,
        account_id=context.aws_account_id,
        cross_account_role=context.aws_role_arn,
        role_inspector=context.role_inspector,
        monthly_aws_spend_ceiling_usd=getattr(
            context,
            "monthly_aws_spend_ceiling_usd",
            DEFAULT_MONTHLY_AWS_SPEND_CEILING_USD,
        ),
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


class _FakeEcr:
    def __init__(
        self,
        *,
        has_dev_tag: bool = True,
        anthus_manifest: str | None = None,
    ) -> None:
        self.has_dev_tag = has_dev_tag
        self.anthus_manifest = anthus_manifest
        self.describe_images_calls: list[dict[str, object]] = []
        self.put_image_calls: list[dict[str, object]] = []

    def describe_images(
        self,
        *,
        repositoryName: str,
        imageIds: list[dict[str, str]],
    ) -> dict[str, object]:
        del repositoryName
        self.describe_images_calls.append({"imageIds": imageIds})
        tag = imageIds[0]["imageTag"]
        if self.has_dev_tag and tag == "dev":
            return {"imageDetails": [{"imageTags": ["dev"]}]}
        raise ClientError(
            {
                "Error": {
                    "Code": "ImageNotFoundException",
                    "Message": f"Images with tag {tag} not found in repository",
                }
            },
            "DescribeImages",
        )

    def batch_get_image(
        self,
        *,
        repositoryName: str,
        imageIds: list[dict[str, str]],
    ) -> dict[str, object]:
        del repositoryName
        tag = imageIds[0]["imageTag"]
        if self.anthus_manifest is None:
            return {"failures": [{"imageTag": tag}]}
        return {
            "images": [{"imageManifest": self.anthus_manifest}],
            "failures": [],
        }

    def put_image(
        self,
        *,
        repositoryName: str,
        imageManifest: str,
        imageTag: str,
    ) -> dict[str, object]:
        self.put_image_calls.append(
            {
                "repositoryName": repositoryName,
                "imageManifest": imageManifest,
                "imageTag": imageTag,
            }
        )
        self.has_dev_tag = True
        return {}


class _FakeEcs:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def run_task(self, **kwargs: object) -> dict[str, object]:
        self.calls.append(kwargs)
        return {"tasks": [{"taskArn": "arn:ecs:task/gherkin"}], "failures": []}


class _FakeCloudFormation:
    _LEGACY_STACK_OUTPUTS: list[dict[str, str]] = [
        {
            "OutputKey": "ComputerClusterName",
            "OutputValue": "cust-cluster",
        },
        {
            "OutputKey": "ComputerTaskDefinitionArn",
            "OutputValue": (
                "arn:aws:ecs:us-east-1:123456789012:task-definition/computer:1"
            ),
        },
        {
            "OutputKey": "ComputerServiceName",
            "OutputValue": "FargateHost",
        },
    ]
    _FULL_STACK_OUTPUTS: list[dict[str, str]] = [
        *_LEGACY_STACK_OUTPUTS,
        {
            "OutputKey": "ComputerPublicSubnetIds",
            "OutputValue": "subnet-customer-1,subnet-customer-2",
        },
        {
            "OutputKey": "ComputerSecurityGroupId",
            "OutputValue": "sg-customer-1",
        },
        {
            "OutputKey": "ComputerRepositoryUri",
            "OutputValue": CUSTOMER_COMPUTER_REPOSITORY_URI,
        },
    ]

    def __init__(
        self,
        *,
        stack_present: bool = True,
        stack_status: str = "CREATE_COMPLETE",
        create_result_status: str = "CREATE_COMPLETE",
        delete_denied: bool = False,
        output_profile: str = "full",
        update_no_op: bool = False,
    ) -> None:
        self.stack_present = stack_present
        self.stack_status = stack_status if stack_present else None
        self.create_result_status = create_result_status
        self.delete_denied = delete_denied
        self.output_profile = output_profile
        self.update_no_op = update_no_op
        self.describe_calls: list[dict[str, object]] = []
        self.create_stack_calls: list[dict[str, object]] = []
        self.delete_stack_calls: list[dict[str, object]] = []
        self.update_stack_calls: list[dict[str, object]] = []

    def _outputs_for_status(self) -> list[dict[str, str]]:
        if self.output_profile == "legacy":
            return list(self._LEGACY_STACK_OUTPUTS)
        return list(self._FULL_STACK_OUTPUTS)

    def describe_stacks(self, **kwargs: object) -> dict[str, object]:
        self.describe_calls.append(kwargs)
        if not self.stack_present:
            raise ClientError(
                {
                    "Error": {
                        "Code": "ValidationError",
                        "Message": "Stack with id ChatticusComputers does not exist",
                    }
                },
                "DescribeStacks",
            )
        stack: dict[str, object] = {"StackStatus": self.stack_status}
        if self.stack_status in {"CREATE_COMPLETE", "UPDATE_COMPLETE"}:
            stack["Outputs"] = self._outputs_for_status()
        return {"Stacks": [stack]}

    def create_stack(self, **kwargs: object) -> dict[str, object]:
        self.create_stack_calls.append(kwargs)
        self.stack_present = True
        self.stack_status = self.create_result_status
        if self.create_result_status == "CREATE_COMPLETE":
            self.output_profile = "full"
        return {"StackId": "arn:aws:cloudformation:stack/gherkin"}

    def update_stack(self, **kwargs: object) -> dict[str, object]:
        self.update_stack_calls.append(kwargs)
        if self.update_no_op:
            raise ClientError(
                {
                    "Error": {
                        "Code": "ValidationError",
                        "Message": "No updates are to be performed.",
                    }
                },
                "UpdateStack",
            )
        self.stack_status = "UPDATE_IN_PROGRESS"
        return {}

    def delete_stack(self, **kwargs: object) -> dict[str, object]:
        if self.delete_denied:
            raise ClientError(
                {
                    "Error": {
                        "Code": "AccessDenied",
                        "Message": "DeleteStack denied",
                    }
                },
                "DeleteStack",
            )
        self.delete_stack_calls.append(kwargs)
        self.stack_status = "DELETE_IN_PROGRESS"
        return {}

    def set_stack_missing(self) -> None:
        self.stack_present = False
        self.stack_status = None

    def set_stack_status(self, status: str) -> None:
        self.stack_present = True
        self.stack_status = status
        if status == "CREATE_COMPLETE":
            self.output_profile = "full"

    def finish_stack_update(self) -> None:
        self.stack_present = True
        self.stack_status = "UPDATE_COMPLETE"
        self.output_profile = "full"

    def allow_delete_stack(self) -> None:
        self.delete_denied = False


class _MultiAccountEcsRecorder:
    def __init__(self) -> None:
        self.deployment = _FakeEcs()
        self.customer = _FakeEcs()

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
    deployment_ecs_config: DeploymentEcsConfig | None = None,
    cloudformation_client: _FakeCloudFormation | None = None,
    customer_computers_provisioner: object | None = None,
    ecr_client: _FakeEcr | None = None,
) -> None:
    _ensure_org_store(context)
    recorder = _MultiAccountEcsRecorder()
    context.ecs_recorder = recorder  # type: ignore[attr-defined]
    cloudformation = cloudformation_client or _FakeCloudFormation()
    context.cloudformation_client = cloudformation  # type: ignore[attr-defined]
    context.assume_role_recorder = assume_role or RecordingAssumeRole()  # type: ignore[attr-defined]
    context.grant_anthus_pull_calls = []  # type: ignore[attr-defined]
    fake_ecr = ecr_client or getattr(context, "ecr_client", None) or _FakeEcr()
    context.ecr_client = fake_ecr  # type: ignore[attr-defined]

    context.host_starter = OrganizationComputerHostStarter(  # type: ignore[attr-defined]
        _plane(context).get_organization,
        deployment_account_id=DEPLOYMENT_ACCOUNT_ID,
        deployment_ecs_config=deployment_ecs_config
        or DeploymentEcsConfig(
            cluster="deployment-cluster",
            task_definition="computer:1",
            subnets=["subnet-deploy-1"],
            security_groups=["sg-deploy-1"],
        ),
        assume_role=context.assume_role_recorder,  # type: ignore[attr-defined]
        ecs_client_factory=recorder.factory,
        cloudformation_client_factory=lambda _credentials: cloudformation,
        ecr_client_factory=lambda _credentials: fake_ecr,
        customer_computers_provisioner=customer_computers_provisioner
        or AwsCustomerComputersProvisioner(),
    )
    context.host_start_error = None  # type: ignore[attr-defined]


@given(
    "an organization provisioned into a customer AWS account "
    "with a ChatticusComputers stack"
)
def given_organization_provisioned_into_customer_account(context: object) -> None:
    org = _provision_cross_account_org(
        context,
        name="Customer Org",
        owner_email="customer-start@example.com",
        account_id=CUSTOMER_ACCOUNT_ID,
        external_id="customer-org-external-id",
    )
    context.start_org = org
    _wire_host_start_context(context, cloudformation_client=_FakeCloudFormation())


@given(
    "an organization provisioned into a customer AWS account "
    "without a ChatticusComputers stack"
)
def given_organization_without_customer_computers_stack(context: object) -> None:
    org = _provision_cross_account_org(
        context,
        name="Customer Org Missing Stack",
        owner_email="missing-stack@example.com",
        account_id=CUSTOMER_ACCOUNT_ID,
        external_id="customer-org-missing-stack",
    )
    context.start_org = org
    _wire_host_start_context(
        context,
        cloudformation_client=_FakeCloudFormation(stack_present=False),
    )


def _provision_customer_org_for_stack_recovery(
    context: object,
    *,
    name: str,
    owner_email: str,
    external_id: str,
    cloudformation: _FakeCloudFormation,
) -> object:
    org = _provision_cross_account_org(
        context,
        name=name,
        owner_email=owner_email,
        account_id=CUSTOMER_ACCOUNT_ID,
        external_id=external_id,
    )
    context.start_org = org
    _wire_host_start_context(context, cloudformation_client=cloudformation)
    return org


@given(
    "an organization provisioned into a customer AWS account with a failed "
    "ChatticusComputers stack in {status} status"
)
def given_organization_with_failed_chatticus_computers_stack(
    context: object,
    status: str,
) -> None:
    cloudformation = _FakeCloudFormation(
        stack_status=status,
        create_result_status="CREATE_IN_PROGRESS",
    )
    context.cloudformation_client = cloudformation  # type: ignore[attr-defined]
    _provision_customer_org_for_stack_recovery(
        context,
        name="Failed Stack Org",
        owner_email="failed-stack@example.com",
        external_id="failed-stack-external-id",
        cloudformation=cloudformation,
    )


@given(
    "an organization provisioned into a customer AWS account whose "
    "ChatticusComputers stack was deleted"
)
def given_organization_with_deleted_chatticus_computers_stack(
    context: object,
) -> None:
    cloudformation = _FakeCloudFormation(
        stack_present=False,
        create_result_status="CREATE_IN_PROGRESS",
    )
    context.cloudformation_client = cloudformation  # type: ignore[attr-defined]
    _provision_customer_org_for_stack_recovery(
        context,
        name="Deleted Stack Org",
        owner_email="deleted-stack@example.com",
        external_id="deleted-stack-external-id",
        cloudformation=cloudformation,
    )


@given("DeleteStack is denied for the customer CloudFormation client")
def given_delete_stack_denied(context: object) -> None:
    cloudformation = context.cloudformation_client  # type: ignore[attr-defined]
    cloudformation.delete_denied = True


@when("DeleteStack is allowed for the customer CloudFormation client")
def when_delete_stack_allowed(context: object) -> None:
    cloudformation = context.cloudformation_client  # type: ignore[attr-defined]
    cloudformation.allow_delete_stack()


@when("the ChatticusComputers stack finishes deleting")
def when_chatticus_computers_stack_finishes_deleting(context: object) -> None:
    cloudformation = context.cloudformation_client  # type: ignore[attr-defined]
    cloudformation.set_stack_missing()


@when("the ChatticusComputers stack finishes creating")
def when_chatticus_computers_stack_finishes_creating(context: object) -> None:
    cloudformation = context.cloudformation_client  # type: ignore[attr-defined]
    cloudformation.set_stack_status("CREATE_COMPLETE")


@given("the ChatticusComputers stack is terminal-failed in {status} status")
def given_chatticus_computers_stack_terminal_failed(
    context: object,
    status: str,
) -> None:
    cloudformation = context.cloudformation_client  # type: ignore[attr-defined]
    cloudformation.set_stack_status(status)


@given("the host starter cannot provision customer infrastructure")
def given_host_starter_cannot_provision(context: object) -> None:
    cloudformation = context.cloudformation_client  # type: ignore[attr-defined]
    context.host_starter = OrganizationComputerHostStarter(  # type: ignore[attr-defined]
        _plane(context).get_organization,
        deployment_account_id=DEPLOYMENT_ACCOUNT_ID,
        deployment_ecs_config=DeploymentEcsConfig(
            cluster="deployment-cluster",
            task_definition="computer:1",
            subnets=["subnet-deploy-1"],
            security_groups=["sg-deploy-1"],
        ),
        assume_role=context.assume_role_recorder,  # type: ignore[attr-defined]
        ecs_client_factory=context.ecs_recorder.factory,  # type: ignore[attr-defined]
        cloudformation_client_factory=lambda _credentials: cloudformation,
        ecr_client_factory=lambda _credentials: getattr(
            context,
            "ecr_client",
            _FakeEcr(),
        ),
        customer_computers_provisioner=RefusingCustomerComputersProvisioner(),
    )


@given("an Anthus-managed organization homed in the deployment AWS account")
def given_anthus_managed_in_deployment_account(context: object) -> None:
    _ensure_org_store(context)
    context.start_org = _plane(context).admin_seed_organization(
        "anthus-managed",
        "anthus-owner@example.com",
        name="Anthus Managed",
        now=context.now,
    )
    _wire_host_start_context(context)


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
    assert len(context.cloudformation_client.describe_calls) >= 1  # type: ignore[attr-defined]


@then("the organization's cross-account role was assumed")
def then_cross_account_role_was_assumed(context: object) -> None:
    recorder = context.assume_role_recorder  # type: ignore[attr-defined]
    org = context.start_org
    assert len(recorder.calls) == 1
    assert recorder.calls[0]["RoleArn"] == org.aws_cross_account_role
    assert recorder.calls[0]["ExternalId"] == org.aws_external_id


@then("the instance is launched with deployment credentials")
def then_instance_launched_with_deployment_credentials(context: object) -> None:
    starter = _host_starter(context)
    assert starter.last_outcome is not None
    assert starter.last_outcome.launch_account_id == DEPLOYMENT_ACCOUNT_ID
    assert len(context.ecs_recorder.deployment.calls) == 1  # type: ignore[attr-defined]


@then("AssumeRole is not called")
def then_assume_role_is_not_called(context: object) -> None:
    recorder = context.assume_role_recorder  # type: ignore[attr-defined]
    assert len(recorder.calls) == 0


@then("no ECS client is opened in a customer account")
def then_no_ecs_client_in_customer_account(context: object) -> None:
    assert len(context.ecs_recorder.customer.calls) == 0  # type: ignore[attr-defined]


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
    message = str(error).lower()
    assert "provisioning" in message or "refused" in message


@then("the start is refused with a provisioning error naming the missing stack")
def then_start_refused_naming_missing_stack(context: object) -> None:
    error = context.host_start_error  # type: ignore[attr-defined]
    assert error is not None
    message = str(error)
    lowered = message.lower()
    assert "chatticuscomputers" in lowered, message
    assert "does not exist" in lowered or "missing" in lowered, message


@then("Chatticus creates the ChatticusComputers stack in the customer account")
def then_chatticus_creates_customer_stack(context: object) -> None:
    cloudformation = context.cloudformation_client  # type: ignore[attr-defined]
    assert len(cloudformation.create_stack_calls) == 1
    create_call = cloudformation.create_stack_calls[0]
    assert create_call["StackName"] == "ChatticusComputers"
    assert "CAPABILITY_IAM" in create_call["Capabilities"]
    assert "CAPABILITY_NAMED_IAM" in create_call["Capabilities"]


@then("Anthus does not grant cross-account ECR pull for the customer account")
def then_anthus_does_not_grant_cross_account_ecr_pull(context: object) -> None:
    calls = getattr(context, "grant_anthus_pull_calls", None)
    assert calls is not None
    assert calls == []


@then("Chatticus describes the ChatticusComputers stack in the customer account")
def then_chatticus_describes_customer_stack(context: object) -> None:
    cloudformation = context.cloudformation_client  # type: ignore[attr-defined]
    assert len(cloudformation.describe_calls) >= 1
    assert cloudformation.describe_calls[0]["StackName"] == "ChatticusComputers"


@then("Chatticus does not create the ChatticusComputers stack")
def then_chatticus_does_not_create_customer_stack(context: object) -> None:
    cloudformation = getattr(context, "cloudformation_client", None)
    if cloudformation is None:
        return
    assert len(cloudformation.create_stack_calls) == 0


@then("Chatticus deletes the ChatticusComputers stack in the customer account")
def then_chatticus_deletes_customer_stack(context: object) -> None:
    cloudformation = context.cloudformation_client  # type: ignore[attr-defined]
    expected_calls = getattr(context, "expected_delete_stack_calls", None)
    if expected_calls is None:
        expected_calls = len(cloudformation.delete_stack_calls)
        context.expected_delete_stack_calls = expected_calls  # type: ignore[attr-defined]
    else:
        expected_calls += 1
        context.expected_delete_stack_calls = expected_calls  # type: ignore[attr-defined]
    assert len(cloudformation.delete_stack_calls) == expected_calls
    delete_call = cloudformation.delete_stack_calls[-1]
    assert delete_call["StackName"] == "ChatticusComputers"


@given(
    "an organization provisioned into a customer AWS account with a "
    "CREATE_COMPLETE ChatticusComputers stack with legacy outputs only"
)
def given_organization_with_legacy_create_complete_stack(context: object) -> None:
    cloudformation = _FakeCloudFormation(
        stack_status="CREATE_COMPLETE",
        output_profile="legacy",
    )
    _provision_customer_org_for_stack_recovery(
        context,
        name="Legacy Output Org",
        owner_email="legacy-outputs@example.com",
        external_id="legacy-outputs-external-id",
        cloudformation=cloudformation,
    )


@given(
    "an organization provisioned into a customer AWS account with a "
    "ChatticusComputers stack in UPDATE_COMPLETE status without subnet outputs"
)
def given_organization_with_update_complete_without_subnet_outputs(
    context: object,
) -> None:
    cloudformation = _FakeCloudFormation(
        stack_status="UPDATE_COMPLETE",
        output_profile="legacy",
    )
    _provision_customer_org_for_stack_recovery(
        context,
        name="Incomplete Update Org",
        owner_email="incomplete-update@example.com",
        external_id="incomplete-update-external-id",
        cloudformation=cloudformation,
    )


@given("UpdateStack reports no changes for the customer CloudFormation client")
def given_update_stack_reports_no_changes(context: object) -> None:
    cloudformation = context.cloudformation_client  # type: ignore[attr-defined]
    cloudformation.update_no_op = True


@when("the ChatticusComputers stack finishes updating")
def when_chatticus_computers_stack_finishes_updating(context: object) -> None:
    cloudformation = context.cloudformation_client  # type: ignore[attr-defined]
    cloudformation.finish_stack_update()


@then("Chatticus updates the ChatticusComputers stack in the customer account")
def then_chatticus_updates_customer_stack(context: object) -> None:
    cloudformation = context.cloudformation_client  # type: ignore[attr-defined]
    assert len(cloudformation.update_stack_calls) == 1
    update_call = cloudformation.update_stack_calls[0]
    assert update_call["StackName"] == "ChatticusComputers"
    assert "CAPABILITY_IAM" in update_call["Capabilities"]
    assert "CAPABILITY_NAMED_IAM" in update_call["Capabilities"]


@then("Chatticus does not delete the ChatticusComputers stack")
def then_chatticus_does_not_delete_customer_stack(context: object) -> None:
    cloudformation = context.cloudformation_client  # type: ignore[attr-defined]
    assert len(cloudformation.delete_stack_calls) == 0


@then("the start is refused with a provisioning error naming incomplete outputs")
def then_start_refused_naming_incomplete_outputs(context: object) -> None:
    error = context.host_start_error  # type: ignore[attr-defined]
    assert error is not None
    message = str(error).lower()
    assert "incomplete" in message or "computerpublicsubnetids" in message
    assert "chatticuscomputers" in message
