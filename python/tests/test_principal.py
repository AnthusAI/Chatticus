"""Principal seam and waitlist-safe route marker tests."""

from __future__ import annotations

import asyncio

import pytest
from starlette.requests import Request

from chatticus.http.principal import (
    NO_PRINCIPAL_ROUTE_PREFIXES,
    NO_PRINCIPAL_ROUTES,
    WAITLIST_SAFE_ROUTE_PATHS,
    is_no_principal_route,
    principal_route_policy,
    resolve_principal,
    waitlist_safe,
)
from chatticus.models import MemberRole, OrganizationStatus
from chatticus.principal import (
    Principal,
    PrincipalKind,
    Role,
)


def test_principal_kind_has_user_and_worker_only() -> None:
    assert set(PrincipalKind) == {PrincipalKind.USER, PrincipalKind.WORKER}


def test_role_is_member_role() -> None:
    assert Role is MemberRole


def test_user_principal_carries_organization_status_and_role() -> None:
    principal = Principal(
        kind=PrincipalKind.USER,
        tenant_id="tenant-1",
        user_id="user-1",
        organization_status=OrganizationStatus.ENABLED,
        role=MemberRole.OWNER,
    )
    assert principal.worker_id is None
    assert principal.organization_status is OrganizationStatus.ENABLED
    assert principal.role is MemberRole.OWNER


def test_user_principal_can_carry_pending_organization_status() -> None:
    principal = Principal(
        kind=PrincipalKind.USER,
        tenant_id="tenant-1",
        user_id="user-1",
        organization_status=OrganizationStatus.PENDING,
        role=MemberRole.OWNER,
    )
    assert principal.organization_status is OrganizationStatus.PENDING


def test_worker_principal_carries_worker_id_only() -> None:
    principal = Principal(
        kind=PrincipalKind.WORKER,
        tenant_id="tenant-1",
        worker_id="worker-1",
    )
    assert principal.user_id is None
    assert principal.organization_status is None
    assert principal.role is None


def test_unmarked_route_requires_enabled_member_by_default() -> None:
    def sample_route() -> None:
        return None

    policy = principal_route_policy(sample_route)
    assert policy.requires_enabled_member
    assert not policy.waitlist_safe


def test_waitlist_safe_marker_opts_out_of_enabled_member_requirement() -> None:
    @waitlist_safe
    def sample_route() -> None:
        return None

    policy = principal_route_policy(sample_route)
    assert policy.waitlist_safe
    assert not policy.requires_enabled_member


def test_get_me_is_named_waitlist_safe_route() -> None:
    assert "/me" in WAITLIST_SAFE_ROUTE_PATHS


def test_health_and_auth_routes_take_no_principal() -> None:
    assert "/health" in NO_PRINCIPAL_ROUTES
    assert is_no_principal_route("/health")
    for prefix in NO_PRINCIPAL_ROUTE_PREFIXES:
        assert is_no_principal_route(f"{prefix}callback")


def test_resolve_principal_is_not_wired_for_users() -> None:
    request = Request(
        {"type": "http", "method": "GET", "path": "/sample", "headers": []}
    )

    with pytest.raises(NotImplementedError, match="not wired"):
        asyncio.run(resolve_principal(request))
