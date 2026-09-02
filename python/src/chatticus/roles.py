"""Named ceilings for organization member roles.

Roles are presentation over :class:`~chatticus.ceiling.Ceiling`, not a separate
permission matrix. Later granularity is a change to ceiling data, not a redesign.
"""

from __future__ import annotations

from chatticus.ceiling import Ceiling
from chatticus.models import CONSEQUENTIAL_ACTION_TYPES, MemberRole

_MEMBER_EXCLUDED_ACTION_TYPES = frozenset({"purchase", "production_change"})

_FULL_ROLE_CEILING = Ceiling(
    action_types=CONSEQUENTIAL_ACTION_TYPES,
    origins=frozenset(),
    recipients=frozenset(),
    file_scopes=frozenset(),
    egress_classes=frozenset(),
    spend_limit=None,
)

_MEMBER_ROLE_CEILING = Ceiling(
    action_types=CONSEQUENTIAL_ACTION_TYPES - _MEMBER_EXCLUDED_ACTION_TYPES,
    origins=frozenset(),
    recipients=frozenset(),
    file_scopes=frozenset(),
    egress_classes=frozenset(),
    spend_limit=None,
)

ROLE_CEILINGS: dict[MemberRole, Ceiling] = {
    MemberRole.OWNER: _FULL_ROLE_CEILING,
    MemberRole.MEMBER: _MEMBER_ROLE_CEILING,
}


def ceiling_for_member_role(role: MemberRole) -> Ceiling:
    """Return the standing authority ceiling preset for one member role."""
    return ROLE_CEILINGS[role]
