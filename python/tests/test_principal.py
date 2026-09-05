"""Principal seam and waitlist-safe route marker tests."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

import pytest
from cognito_test_support import make_cognito_test_keys, mint_id_token
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from starlette.requests import Request

from chatticus.control_plane import ControlPlane
from chatticus.http.app import create_app
from chatticus.http.paths import org_path
from chatticus.http.principal import (
    NO_PRINCIPAL_ROUTE_PREFIXES,
    NO_PRINCIPAL_ROUTES,
    WAITLIST_SAFE_ROUTE_PATHS,
    OrgAccessDeniedError,
    PrincipalRoutePolicy,
    is_no_principal_route,
    principal_route_policy,
    resolve_principal,
    verify_org_access,
    waitlist_safe,
)
from chatticus.models import MemberRole, OrganizationStatus
from chatticus.org_records import ANTHUS_TENANT_ID
from chatticus.principal import (
    Principal,
    PrincipalKind,
    Role,
)

NOW = datetime(2026, 8, 31, 12, 0, 0, tzinfo=UTC)


def test_principal_kind_includes_user_worker_and_operator() -> None:
    assert set(PrincipalKind) == {
        PrincipalKind.USER,
        PrincipalKind.WORKER,
        PrincipalKind.OPERATOR,
    }


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


def test_verify_org_access_rejects_pending_member_on_enabled_only_route() -> None:
    plane = ControlPlane()
    owner = plane.sign_in("owner@example.com", now=NOW)
    plane._org_records._put_pending_organization(
        owner,
        ANTHUS_TENANT_ID,
        tenant_id=ANTHUS_TENANT_ID,
        now=NOW,
    )
    principal = Principal(
        kind=PrincipalKind.USER,
        tenant_id=ANTHUS_TENANT_ID,
        user_id=owner.user_id,
        organization_status=OrganizationStatus.PENDING,
        role=MemberRole.OWNER,
    )
    with pytest.raises(OrgAccessDeniedError, match="enabled membership is required"):
        verify_org_access(
            principal,
            ANTHUS_TENANT_ID,
            policy=PrincipalRoutePolicy(),
            plane=plane,
        )


def test_resolve_principal_is_wired_for_org_user_routes() -> None:
    keys = make_cognito_test_keys()
    plane = ControlPlane()
    plane.admin_seed_organization(
        ANTHUS_TENANT_ID,
        "owner@example.com",
        name="Anthus",
        now=NOW,
    )
    app = create_app(plane, invoke_key="", cognito_verifier=keys.verifier())
    client = TestClient(app)
    response = client.post(
        org_path(ANTHUS_TENANT_ID, "/bots"),
        json={"user_id": "ryan", "name": "Helper"},
    )
    assert response.status_code == 403
    token = mint_id_token(keys, email="owner@example.com")
    response = client.post(
        org_path(ANTHUS_TENANT_ID, "/bots"),
        json={"user_id": "ryan", "name": "Helper"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200


def test_resolve_principal_rejects_cross_org_membership() -> None:
    keys = make_cognito_test_keys()
    plane = ControlPlane()
    plane.admin_seed_organization(
        ANTHUS_TENANT_ID,
        "owner@example.com",
        name="Anthus",
        now=NOW,
    )
    app = create_app(plane, invoke_key="", cognito_verifier=keys.verifier())
    client = TestClient(app)
    token = mint_id_token(keys, email="owner@example.com")
    response = client.post(
        org_path("other-household", "/bots"),
        json={"user_id": "ryan", "name": "Helper"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 403


def test_resolve_principal_raises_on_no_principal_route() -> None:
    app = FastAPI()

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/health",
            "headers": [],
            "app": app,
        }
    )

    with pytest.raises(HTTPException, match="no-principal route"):
        asyncio.run(resolve_principal(request))
