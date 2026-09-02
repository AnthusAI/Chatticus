"""Unit tests for member role ceiling presets."""

from __future__ import annotations

from datetime import UTC, datetime

from chatticus.models import CONSEQUENTIAL_ACTION_TYPES, MemberRole, Membership
from chatticus.roles import ROLE_CEILINGS, ceiling_for_member_role

NOW = datetime(2026, 8, 31, 12, 0, 0, tzinfo=UTC)


def test_role_ceilings_cover_every_member_role() -> None:
    assert set(ROLE_CEILINGS) == set(MemberRole)


def test_owner_role_ceiling_is_full_consequential_standing() -> None:
    ceiling = ceiling_for_member_role(MemberRole.OWNER)
    assert ceiling.action_types == CONSEQUENTIAL_ACTION_TYPES
    assert ceiling.spend_limit is None


def test_member_role_ceiling_excludes_purchase_and_production_change() -> None:
    ceiling = ceiling_for_member_role(MemberRole.MEMBER)
    assert "purchase" not in ceiling.action_types
    assert "production_change" not in ceiling.action_types
    assert ceiling.action_types == CONSEQUENTIAL_ACTION_TYPES - frozenset(
        {"purchase", "production_change"}
    )


def test_membership_ceiling_derives_from_role() -> None:
    membership = Membership(
        tenant_id="tenant-1",
        user_id="user-1",
        role=MemberRole.MEMBER,
        joined_at=NOW,
    )
    assert membership.ceiling == ceiling_for_member_role(MemberRole.MEMBER)
