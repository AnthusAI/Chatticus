"""Shared org membership helpers for behave fixtures."""

from __future__ import annotations

from http_test_support import NOW

from chatticus.control_plane import ControlPlane
from chatticus.models import Identity, MemberRole, Membership, OrganizationNotFoundError
from chatticus.org_records import normalize_email


def ensure_messaging_user_membership(
    plane: ControlPlane,
    tenant_id: str,
    user_id: str,
) -> None:
    """Attach membership for one messaging user when the tenant already has an org."""
    try:
        plane.get_organization(tenant_id)
    except OrganizationNotFoundError:
        return
    if plane.get_membership(tenant_id, user_id) is not None:
        return
    email = normalize_email(f"{user_id}@{tenant_id}.test")
    identity = plane._org_records.store.get_identity_by_email(email)
    if identity is None:
        identity = Identity(user_id=user_id, email=email, created_at=NOW)
        plane._org_records.store.put_identity(identity)
    plane._messaging_store.put_membership(
        Membership(
            tenant_id=tenant_id,
            user_id=user_id,
            role=MemberRole.OWNER,
            joined_at=NOW,
        )
    )
