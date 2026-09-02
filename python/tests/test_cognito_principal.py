"""Tests for Cognito id_token to user Principal resolution."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from cognito_test_support import make_cognito_test_keys, mint_id_token
from fastapi.testclient import TestClient

from chatticus.cognito_jwt import CognitoTokenError
from chatticus.control_plane import ControlPlane
from chatticus.http.app import create_app
from chatticus.http.paths import org_path
from chatticus.http.principal import (
    _MEMBERSHIP_CACHE,
    resolve_user_principal_from_token,
)
from chatticus.models import (
    IdentityNotFoundError,
    MemberRole,
    MembershipNotFoundError,
    OrganizationStatus,
)
from chatticus.org_records import ANTHUS_TENANT_ID
from chatticus.principal import PrincipalKind

NOW = datetime(2026, 8, 31, 12, 0, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def clear_membership_cache() -> None:
    _MEMBERSHIP_CACHE.clear()


@pytest.fixture
def keys() -> object:
    return make_cognito_test_keys()


@pytest.fixture
def seeded_plane() -> ControlPlane:
    plane = ControlPlane()
    plane.admin_seed_organization(
        ANTHUS_TENANT_ID,
        "owner@example.com",
        name="Anthus",
        now=NOW,
    )
    return plane


def test_valid_id_token_resolves_user_principal(
    seeded_plane: ControlPlane, keys: object
) -> None:
    token = mint_id_token(keys, email="owner@example.com")
    principal = resolve_user_principal_from_token(
        seeded_plane,
        ANTHUS_TENANT_ID,
        token,
        verifier=keys.verifier(),
    )
    assert principal.kind == PrincipalKind.USER
    assert principal.tenant_id == ANTHUS_TENANT_ID
    assert principal.user_id is not None
    assert principal.organization_status == OrganizationStatus.ENABLED
    assert principal.role == MemberRole.OWNER
    assert principal.worker_id is None


def test_expired_id_token_is_rejected(seeded_plane: ControlPlane, keys: object) -> None:
    token = mint_id_token(
        keys,
        email="owner@example.com",
        expires_at=datetime(2020, 1, 1, tzinfo=UTC),
    )
    with pytest.raises(CognitoTokenError, match="expired"):
        resolve_user_principal_from_token(
            seeded_plane,
            ANTHUS_TENANT_ID,
            token,
            verifier=keys.verifier(),
        )


def test_unknown_email_is_rejected(seeded_plane: ControlPlane, keys: object) -> None:
    token = mint_id_token(keys, email="unknown@example.com")
    with pytest.raises(IdentityNotFoundError):
        resolve_user_principal_from_token(
            seeded_plane,
            ANTHUS_TENANT_ID,
            token,
            verifier=keys.verifier(),
        )


def test_suspended_organization_returns_suspended_principal(
    seeded_plane: ControlPlane, keys: object
) -> None:
    seeded_plane.suspend_organization(ANTHUS_TENANT_ID)
    token = mint_id_token(keys, email="owner@example.com")
    principal = resolve_user_principal_from_token(
        seeded_plane,
        ANTHUS_TENANT_ID,
        token,
        verifier=keys.verifier(),
    )
    assert principal.organization_status == OrganizationStatus.SUSPENDED


def test_non_member_email_is_rejected(seeded_plane: ControlPlane, keys: object) -> None:
    other = seeded_plane.sign_in("other@example.com", now=NOW)
    token = mint_id_token(keys, email=other.email)
    with pytest.raises(MembershipNotFoundError):
        resolve_user_principal_from_token(
            seeded_plane,
            ANTHUS_TENANT_ID,
            token,
            verifier=keys.verifier(),
        )


def test_identity_is_email_keyed_not_cognito_sub(
    seeded_plane: ControlPlane, keys: object
) -> None:
    identity = seeded_plane.get_identity_by_email("owner@example.com")
    assert identity is not None
    token = mint_id_token(keys, email="owner@example.com", sub="cognito-sub-not-used")
    principal = resolve_user_principal_from_token(
        seeded_plane,
        ANTHUS_TENANT_ID,
        token,
        verifier=keys.verifier(),
    )
    assert principal.user_id == identity.user_id


def test_user_route_requires_cognito_token(keys: object) -> None:
    plane = ControlPlane()
    client = TestClient(
        create_app(plane, invoke_key="", cognito_verifier=keys.verifier())
    )
    response = client.post(
        org_path("anthus", "/bots"),
        json={"user_id": "ryan", "name": "Helper"},
    )
    assert response.status_code == 403
