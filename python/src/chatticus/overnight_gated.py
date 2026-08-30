"""Unattended consequential actions: stop honestly or match a human rule.

v1 is a web tab. Device push can only say come back. A routine that
reaches send, publish, purchase, delete, or production change with no
human at a screen has no completable approval path. Overnight work may
run a consequential class only when a human, out of band, created an
always-allow rule that binds the exact structured operation. Generic
browser actions cannot be pre-authorized. A bot cannot loosen auto-review
on its own initiative.
"""

from __future__ import annotations

from dataclasses import dataclass

from chatticus.models import (
    CONSEQUENTIAL_ACTION_TYPES,
    AutoReviewRule,
    AutoReviewRuleKind,
)

WAITING_FOR_HUMAN = "waiting_for_human"
USER_CONTROLLED_COMPLETION_REQUIRED = "user_controlled_completion_required"
CHANNEL_STRUCTURED = "structured"
CHANNEL_BROWSER = "browser"


@dataclass(frozen=True)
class OvernightGatedResult:
    """Outcome of one unattended consequential-action attempt."""

    executed: bool
    turn_status: str
    reason: str | None
    completion_evidence: str | None
    retried_unattended: bool = False


def resolve_unattended_gated_action(
    *,
    action_type: str,
    arguments: dict[str, str],
    channel: str,
    rules: list[AutoReviewRule],
    tenant_id: str,
    user_id: str | None = None,
    completion_evidence: str = "system-accepted",
) -> OvernightGatedResult:
    """Decide whether an overnight consequential action may run."""
    if action_type not in CONSEQUENTIAL_ACTION_TYPES:
        return OvernightGatedResult(
            executed=True,
            turn_status="completed",
            reason=None,
            completion_evidence=None,
        )
    if channel == CHANNEL_BROWSER:
        return OvernightGatedResult(
            executed=False,
            turn_status="blocked",
            reason=USER_CONTROLLED_COMPLETION_REQUIRED,
            completion_evidence=None,
            retried_unattended=False,
        )
    matching = [
        rule
        for rule in rules
        if rule.kind == AutoReviewRuleKind.ALWAYS_ALLOW
        and rule.created_by == "human"
        and rule.action_type == action_type
        and rule.tenant_id == tenant_id
        and (rule.user_id is None or rule.user_id == user_id)
        and rule.argument_bindings
        and dict(rule.argument_bindings) == arguments
    ]
    if matching:
        return OvernightGatedResult(
            executed=True,
            turn_status="completed",
            reason=None,
            completion_evidence=completion_evidence,
        )
    return OvernightGatedResult(
        executed=False,
        turn_status="blocked",
        reason=WAITING_FOR_HUMAN,
        completion_evidence=None,
    )
