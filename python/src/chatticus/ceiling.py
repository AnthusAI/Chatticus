"""Member authority ceilings and clipping against standing grants.

A ceiling is the standing analogue of
:class:`~chatticus.capability_policy.TaskCapabilityGrant`:
action types with argument constraints, origins, recipients, file scopes, egress
classes, ingest classes, and a spend limit. Clipping is set intersection on those
fields; no one
may grant, approve, or always-allow beyond their own ceiling.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import overload

from chatticus.capability_policy import TaskCapabilityGrant


@dataclass(frozen=True)
class Ceiling:
    """Standing authority a member holds, not one a task receives."""

    action_types: frozenset[str]
    origins: frozenset[str]
    recipients: frozenset[str]
    file_scopes: frozenset[str]
    egress_classes: frozenset[str]
    ingest_classes: frozenset[str]
    spend_limit: Decimal | None = None


def _clip_spend_limit(left: Decimal | None, right: Decimal | None) -> Decimal | None:
    if left is None:
        return right
    if right is None:
        return left
    return min(left, right)


@overload
def clip(grant: TaskCapabilityGrant, ceiling: Ceiling) -> TaskCapabilityGrant: ...


@overload
def clip(grant: Ceiling, ceiling: Ceiling) -> Ceiling: ...


def clip(
    grant: TaskCapabilityGrant | Ceiling, ceiling: Ceiling
) -> TaskCapabilityGrant | Ceiling:
    """Return ``grant`` intersected with ``ceiling``.

    The same operation applies to task grants, delegations, rules, and
    approvals: no field may extend beyond the bounding ceiling.
    """
    if isinstance(grant, Ceiling):
        return Ceiling(
            action_types=grant.action_types & ceiling.action_types,
            origins=grant.origins & ceiling.origins,
            recipients=grant.recipients & ceiling.recipients,
            file_scopes=grant.file_scopes & ceiling.file_scopes,
            egress_classes=grant.egress_classes & ceiling.egress_classes,
            ingest_classes=grant.ingest_classes & ceiling.ingest_classes,
            spend_limit=_clip_spend_limit(grant.spend_limit, ceiling.spend_limit),
        )
    return TaskCapabilityGrant(
        tools=grant.tools & ceiling.action_types,
        origins=grant.origins & ceiling.origins,
        recipients=grant.recipients & ceiling.recipients,
        file_scopes=grant.file_scopes & ceiling.file_scopes,
        egress_classes=grant.egress_classes & ceiling.egress_classes,
        ingest_classes=grant.ingest_classes & ceiling.ingest_classes,
    )


def grant_exceeds_ceiling(grant: TaskCapabilityGrant, ceiling: Ceiling) -> bool:
    """Return whether ``grant`` requests authority outside ``ceiling``."""
    return clip(grant, ceiling) != grant
