"""Behave steps for the principal seam and waitlist-safe route marker."""

from __future__ import annotations

from behave import given, then

from chatticus.http.principal import (
    WAITLIST_SAFE_ROUTE_PATHS,
    is_no_principal_route,
    principal_route_policy,
    waitlist_safe,
)
from chatticus.models import MemberRole, OrganizationStatus
from chatticus.principal import Principal, PrincipalKind


@given('a user principal for tenant "{tenant_id}"')
def given_user_principal(context: object, tenant_id: str) -> None:
    context.user_principal = Principal(
        kind=PrincipalKind.USER,
        tenant_id=tenant_id,
        user_id="user-1",
        organization_status=OrganizationStatus.ENABLED,
        role=MemberRole.OWNER,
    )


@then('that principal has kind "{kind}"')
def then_principal_has_kind(context: object, kind: str) -> None:
    assert context.user_principal.kind == PrincipalKind(kind)


@then('a worker principal for tenant "{tenant_id}" has kind "{kind}"')
def then_worker_principal_has_kind(context: object, tenant_id: str, kind: str) -> None:
    worker = Principal(
        kind=PrincipalKind.WORKER,
        tenant_id=tenant_id,
        worker_id="worker-1",
    )
    assert worker.kind == PrincipalKind(kind)


@given("an unmarked route handler")
def given_unmarked_route(context: object) -> None:
    def route_handler() -> None:
        return None

    context.route_handler = route_handler


@then("that route requires an enabled member")
def then_route_requires_enabled_member(context: object) -> None:
    policy = principal_route_policy(context.route_handler)
    assert policy.requires_enabled_member


@given("a route handler marked waitlist-safe")
def given_waitlist_safe_route(context: object) -> None:
    @waitlist_safe
    def route_handler() -> None:
        return None

    context.route_handler = route_handler


@then("that route does not require an enabled member")
def then_route_does_not_require_enabled_member(context: object) -> None:
    policy = principal_route_policy(context.route_handler)
    assert not policy.requires_enabled_member


@then('"{path}" is a named waitlist-safe route')
def then_path_is_waitlist_safe(context: object, path: str) -> None:
    assert path in WAITLIST_SAFE_ROUTE_PATHS


@then('"{path}" is outside the principal marker system')
def then_path_is_outside_principal_system(context: object, path: str) -> None:
    assert is_no_principal_route(path)
