"""Behave steps for the authenticated operator organization lifecycle API."""

from __future__ import annotations

from behave import given, then, when
from browser_auth_helpers import (
    cognito_test_keys,
    wire_test_http_front_door,
)
from cognito_test_support import mint_id_token
from worker_http_helpers import register_worker_for_http, worker_auth_headers

from chatticus.http.app import INVOKE_HEADER
from chatticus.http.paths import operator_org_path
from chatticus.models import OrganizationStatus

DEFAULT_OPERATOR_KEY = "test-operator-secret"
DEFAULT_OWNER_EMAIL = "owner@example.com"
DEFAULT_ORG_NAME = "Anthus Labs"


def _operator_headers(context: object) -> dict[str, str]:
    token = getattr(context, "operator_bearer_token", None)
    if token is None:
        return {}
    return {"Authorization": f"Bearer {token}"}


def _merge_headers(
    context: object, extra: dict[str, str] | None = None
) -> dict[str, str]:
    headers = dict(getattr(context, "operator_request_headers", {}) or {})
    headers.update(_operator_headers(context))
    if extra:
        headers.update(extra)
    return headers


def _organization(context: object) -> object:
    organization = getattr(context, "operator_organization", None)
    if organization is None:
        raise AssertionError("No operator scenario organization is set.")
    return organization


def _kernel_transition_error(
    action: str, tenant_id: str, status: OrganizationStatus
) -> str:
    if action == "enable":
        return (
            f"Organization {tenant_id!r} has status "
            f"{status!r}; enable requires pending."
        )
    if action == "suspend":
        return (
            f"Organization {tenant_id!r} has status "
            f"{status!r}; suspend requires enabled."
        )
    if action == "reinstate":
        return (
            f"Organization {tenant_id!r} has status "
            f"{status!r}; reinstate requires suspended."
        )
    raise AssertionError(f"Unknown operator action {action!r}.")


@given('the operator HTTP front door is wired with operator key "{operator_key}"')
def given_operator_http_front_door(context: object, operator_key: str) -> None:
    context.operator_organization = None
    context.operator_last_action = None
    context.operator_response = None
    context.operator_request_headers = {}
    context.operator_bearer_token = None
    wire_test_http_front_door(
        context,
        context.plane,
        invoke_key="",
        operator_key=operator_key,
    )
    context.configured_operator_key = operator_key


@given("the operator HTTP front door has no operator key configured")
def given_operator_http_front_door_unconfigured(context: object) -> None:
    wire_test_http_front_door(context, context.plane, invoke_key="", operator_key="")
    context.configured_operator_key = ""


@given('the HTTP front door requires invoke key "{invoke_key}"')
def given_http_front_door_invoke_key(context: object, invoke_key: str) -> None:
    operator_key = getattr(context, "configured_operator_key", DEFAULT_OPERATOR_KEY)
    wire_test_http_front_door(
        context,
        context.plane,
        invoke_key=invoke_key,
        operator_key=operator_key,
    )
    context.operator_request_headers = {INVOKE_HEADER: invoke_key}


@given("an organization in pending status")
def given_organization_pending(context: object) -> None:
    owner = context.plane.sign_in(DEFAULT_OWNER_EMAIL, now=context.now)
    organization = context.plane.create_organization(
        owner, DEFAULT_ORG_NAME, now=context.now
    )
    context.operator_organization = organization
    context.orgs_by_name = {DEFAULT_ORG_NAME: organization}


@given('an organization in pending status for owner "{email}"')
def given_organization_pending_for_owner(context: object, email: str) -> None:
    owner = context.plane.sign_in(email, now=context.now)
    organization = context.plane.create_organization(
        owner, DEFAULT_ORG_NAME, now=context.now
    )
    context.operator_organization = organization
    context.orgs_by_name = {DEFAULT_ORG_NAME: organization}
    context.operator_owner_email = email


@given("an organization in enabled status")
def given_organization_enabled(context: object) -> None:
    given_organization_pending(context)
    context.operator_organization = context.plane.enable_organization(
        context.operator_organization.tenant_id
    )
    context.orgs_by_name[DEFAULT_ORG_NAME] = context.operator_organization


@given("an authenticated operator credential")
def given_authenticated_operator_credential(context: object) -> None:
    context.operator_bearer_token = getattr(
        context, "configured_operator_key", DEFAULT_OPERATOR_KEY
    )


@given("that organization has been suspended")
def given_organization_suspended(context: object) -> None:
    organization = _organization(context)
    context.operator_organization = context.plane.suspend_organization(
        organization.tenant_id
    )
    context.orgs_by_name[DEFAULT_ORG_NAME] = context.operator_organization


@given("a worker registered for that organization")
def given_worker_for_organization(context: object) -> None:
    organization = _organization(context)
    context.last_worker_id = "operator-test-worker"
    register_worker_for_http(
        context,
        organization.tenant_id,
        context.last_worker_id,
    )


@when("the operator calls the enable endpoint for that organization")
def when_operator_calls_enable(context: object) -> None:
    when_operator_calls_endpoint(context, "enable")


@when("the operator calls the suspend endpoint for that organization")
def when_operator_calls_suspend(context: object) -> None:
    when_operator_calls_endpoint(context, "suspend")


@when("the operator calls the reinstate endpoint for that organization")
def when_operator_calls_reinstate(context: object) -> None:
    when_operator_calls_endpoint(context, "reinstate")


def when_operator_calls_endpoint(context: object, action: str) -> None:
    organization = _organization(context)
    context.operator_last_action = action
    context.operator_response = context.raw_api_client.post(
        operator_org_path(organization.tenant_id, action),
        headers=_merge_headers(context),
    )


@when("a request without a valid operator credential calls the enable endpoint")
def when_unauthenticated_enable(context: object) -> None:
    organization = _organization(context)
    context.operator_last_action = "enable"
    context.operator_bearer_token = None
    context.operator_response = context.raw_api_client.post(
        operator_org_path(organization.tenant_id, "enable"),
        headers=_merge_headers(context),
    )


@when("the owner calls the enable endpoint with a Cognito JWT")
def when_owner_calls_enable_with_jwt(context: object) -> None:
    organization = _organization(context)
    email = getattr(context, "operator_owner_email", DEFAULT_OWNER_EMAIL)
    token = mint_id_token(cognito_test_keys(context), email=email)
    context.operator_last_action = "enable"
    context.operator_response = context.raw_api_client.post(
        operator_org_path(organization.tenant_id, "enable"),
        headers={"Authorization": f"Bearer {token}"},
    )


@when("the worker calls the enable endpoint with its bearer token")
def when_worker_calls_enable(context: object) -> None:
    organization = _organization(context)
    context.operator_last_action = "enable"
    context.operator_response = context.raw_api_client.post(
        operator_org_path(organization.tenant_id, "enable"),
        headers=worker_auth_headers(context, context.last_worker_id),
    )


@when("the enable endpoint is called with only the invoke key")
def when_enable_with_invoke_key_only(context: object) -> None:
    organization = _organization(context)
    context.operator_last_action = "enable"
    context.operator_response = context.raw_api_client.post(
        operator_org_path(organization.tenant_id, "enable"),
        headers=dict(context.operator_request_headers),
    )


@when('the enable endpoint is called with bearer "{token}"')
def when_enable_with_bearer(context: object, token: str) -> None:
    organization = _organization(context)
    context.operator_last_action = "enable"
    context.operator_response = context.raw_api_client.post(
        operator_org_path(organization.tenant_id, "enable"),
        headers={"Authorization": f"Bearer {token}"},
    )


@then("the organization becomes enabled")
def then_organization_enabled(context: object) -> None:
    organization = _organization(context)
    updated = context.plane.get_organization(organization.tenant_id)
    assert updated.status == OrganizationStatus.ENABLED


@then("the organization becomes suspended")
def then_organization_suspended(context: object) -> None:
    organization = _organization(context)
    updated = context.plane.get_organization(organization.tenant_id)
    assert updated.status == OrganizationStatus.SUSPENDED


@then("the operator response status is {status:d}")
def then_operator_response_status(context: object, status: int) -> None:
    assert context.operator_response is not None
    assert (
        context.operator_response.status_code == status
    ), context.operator_response.text


@then("the organization status is unchanged")
def then_organization_status_unchanged(context: object) -> None:
    organization = _organization(context)
    updated = context.plane.get_organization(organization.tenant_id)
    assert updated.status == organization.status


@then("the organization status is suspended")
def then_organization_status_is_suspended(context: object) -> None:
    organization = _organization(context)
    updated = context.plane.get_organization(organization.tenant_id)
    assert updated.status == OrganizationStatus.SUSPENDED


@then("no computer exists for that organization")
def then_no_computer_for_organization(context: object) -> None:
    organization = _organization(context)
    try:
        context.plane.computer_for_organization(organization.tenant_id)
    except KeyError:
        return
    raise AssertionError(
        f"Expected no computer for organization {organization.tenant_id!r}."
    )


@then("the same state transition the members CLI produces occurs")
def then_same_transition_as_members_cli(context: object) -> None:
    organization = _organization(context)
    updated = context.plane.get_organization(organization.tenant_id)
    assert updated.status == OrganizationStatus.ENABLED
    assert updated.tenant_id == organization.tenant_id
    assert updated.name == organization.name


@then("the operator response detail matches the kernel enable transition error")
def then_operator_enable_kernel_error(context: object) -> None:
    organization = _organization(context)
    expected = _kernel_transition_error(
        "enable", organization.tenant_id, organization.status
    )
    assert context.operator_response.json()["detail"] == expected


@then("the operator response detail matches the kernel suspend transition error")
def then_operator_suspend_kernel_error(context: object) -> None:
    organization = _organization(context)
    expected = _kernel_transition_error(
        "suspend", organization.tenant_id, organization.status
    )
    assert context.operator_response.json()["detail"] == expected


@then("the operator response detail matches the kernel reinstate transition error")
def then_operator_reinstate_kernel_error(context: object) -> None:
    organization = _organization(context)
    expected = _kernel_transition_error(
        "reinstate", organization.tenant_id, organization.status
    )
    assert context.operator_response.json()["detail"] == expected
