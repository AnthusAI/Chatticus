"""Tests for org membership access checks on the principal seam."""

from __future__ import annotations

from datetime import datetime

import pytest

from chatticus.control_plane import ControlPlane
from chatticus.http.principal import (
    OrgAccessDeniedError,
    PrincipalRoutePolicy,
    verify_org_access,
)
from chatticus.models import MemberRole, OrganizationStatus
from chatticus.principal import Principal, PrincipalKind


def _enabled_user(tenant_id: str, user_id: str) -> Principal:
    return Principal(
        kind=PrincipalKind.USER,
        tenant_id=tenant_id,
        user_id=user_id,
        organization_status=OrganizationStatus.ENABLED,
        role=MemberRole.OWNER,
    )


def test_verify_org_access_allows_enabled_member() -> None:
    plane = ControlPlane()
    now = datetime(2026, 1, 1)
    owner = plane.sign_in("owner@example.com", now=now)
    org = plane.create_organization(owner, "Anthus", now=now)
    plane.enable_organization(org.tenant_id)
    verify_org_access(
        _enabled_user(org.tenant_id, owner.user_id),
        org.tenant_id,
        policy=PrincipalRoutePolicy(),
        plane=plane,
    )


def test_verify_org_access_rejects_non_member() -> None:
    plane = ControlPlane()
    now = datetime(2026, 1, 1)
    owner = plane.sign_in("owner@example.com", now=now)
    org = plane.create_organization(owner, "Anthus", now=now)
    plane.enable_organization(org.tenant_id)
    with pytest.raises(OrgAccessDeniedError, match="not a member"):
        verify_org_access(
            _enabled_user(org.tenant_id, "stranger"),
            org.tenant_id,
            policy=PrincipalRoutePolicy(),
            plane=plane,
        )


def test_verify_org_access_requires_worker_tenant_match() -> None:
    plane = ControlPlane()
    worker = Principal(
        kind=PrincipalKind.WORKER,
        tenant_id="anthus",
        worker_id="worker-1",
    )
    with pytest.raises(OrgAccessDeniedError, match="not registered"):
        verify_org_access(
            worker,
            "other-household",
            policy=PrincipalRoutePolicy(),
            plane=plane,
        )
