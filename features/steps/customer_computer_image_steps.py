"""Behave steps for customer-account computer image ownership."""

from __future__ import annotations

from behave import given, then, when
from cross_account_provisioning_steps import (
    CUSTOMER_ACCOUNT_ID,
    CUSTOMER_COMPUTER_REPOSITORY_URI,
    CUSTOMER_ROLE_ARN,
    NOW,
    _ensure_org_store,
    _FakeEcr,
    _plane,
)

from chatticus.customer_computer_image import publish_dev_image_from_anthus
from chatticus.customer_computers_template import load_customer_computers_template
from chatticus.models import AwsSetupPath


@given("the customer computer repository has no dev tag")
def given_customer_repository_has_no_dev_tag(context: object) -> None:
    ecr = getattr(context, "ecr_client", None)
    if ecr is None:
        ecr = _FakeEcr(has_dev_tag=False)
        context.ecr_client = ecr  # type: ignore[attr-defined]
    else:
        ecr.has_dev_tag = False


@given("the customer computer image tag dev exists")
def given_customer_computer_image_tag_dev_exists(context: object) -> None:
    ecr = getattr(context, "ecr_client", None)
    if ecr is None:
        ecr = _FakeEcr(has_dev_tag=True)
        context.ecr_client = ecr  # type: ignore[attr-defined]
    else:
        ecr.has_dev_tag = True


@given("a ChatticusComputers stack with an empty customer ECR repository")
def given_empty_customer_ecr_repository(context: object) -> None:
    _ensure_org_store(context)
    identity = _plane(context).sign_in("publish@example.com", now=NOW)
    org = _plane(context).create_organization(identity, "Publish Org", now=NOW)
    _plane(context).enable_organization(org.tenant_id)
    context.publish_org = _plane(context).provision_organization_aws(  # type: ignore[attr-defined]
        org.tenant_id,
        account_id=CUSTOMER_ACCOUNT_ID,
        cross_account_role=CUSTOMER_ROLE_ARN,
        external_id=org.tenant_id,
        setup_path=AwsSetupPath.CUSTOMER_OWNED,
    )
    context.customer_ecr = _FakeEcr(has_dev_tag=False)  # type: ignore[attr-defined]
    context.anthus_ecr = _FakeEcr(  # type: ignore[attr-defined]
        has_dev_tag=True,
        anthus_manifest='{"schemaVersion":2,"mediaType":"application/vnd.docker.distribution.manifest.v2+json"}',
    )
    context.publish_used_assumed_role = False  # type: ignore[attr-defined]


@when("the customer computer image is published from Anthus dev")
def when_customer_computer_image_published_from_anthus(context: object) -> None:
    context.publish_used_assumed_role = True  # type: ignore[attr-defined]
    publish_dev_image_from_anthus(
        context.anthus_ecr,  # type: ignore[attr-defined]
        context.customer_ecr,  # type: ignore[attr-defined]
        anthus_repository_name="chatticuscomputers-computerimage",
        customer_repository_name="chatticuscomputers-computerimage",
    )
    context.published_image_uri = (  # type: ignore[attr-defined]
        f"{CUSTOMER_COMPUTER_REPOSITORY_URI}:dev"
    )


@then("the committed customer ChatticusComputers template declares an ECR repository")
def then_committed_template_declares_ecr_repository(context: object) -> None:
    template = load_customer_computers_template()
    resources = template.get("Resources", {})
    assert any(
        isinstance(resource, dict) and resource.get("Type") == "AWS::ECR::Repository"
        for resource in resources.values()
    )


@then("CreateStack parameters include only TenantId")
def then_create_stack_parameters_include_only_tenant_id(context: object) -> None:
    cloudformation = context.cloudformation_client  # type: ignore[attr-defined]
    assert len(cloudformation.create_stack_calls) == 1
    parameters = cloudformation.create_stack_calls[0].get("Parameters") or []
    assert parameters == [
        {"ParameterKey": "TenantId", "ParameterValue": context.start_org.tenant_id}
    ]


@then(
    "the start is refused with a provisioning error naming the missing computer image"
)
def then_start_refused_naming_missing_computer_image(context: object) -> None:
    error = context.host_start_error  # type: ignore[attr-defined]
    assert error is not None
    message = str(error).lower()
    assert "missing" in message or "publish" in message
    assert "dev" in message or ":dev" in message


@then("no customer ECS RunTask was attempted")
def then_no_customer_ecs_run_task_attempted(context: object) -> None:
    recorder = getattr(context, "ecs_recorder", None)
    assert recorder is not None
    assert len(recorder.customer.calls) == 0
    assert len(recorder.deployment.calls) == 0


@then("the RunTask task definition image URI is in the customer AWS account")
def then_run_task_image_uri_in_customer_account(context: object) -> None:
    recorder = context.ecs_recorder  # type: ignore[attr-defined]
    assert len(recorder.customer.calls) == 1
    task_definition = recorder.customer.calls[0]["taskDefinition"]
    assert CUSTOMER_ACCOUNT_ID in task_definition


@then("the publish used the organization cross-account role")
def then_publish_used_cross_account_role(context: object) -> None:
    assert context.publish_used_assumed_role is True  # type: ignore[attr-defined]


@then("the published image URI is in the customer AWS account")
def then_published_image_uri_in_customer_account(context: object) -> None:
    published = context.published_image_uri  # type: ignore[attr-defined]
    assert published.startswith(f"{CUSTOMER_ACCOUNT_ID}.dkr.ecr.")
    assert published.endswith(":dev")
