"""Mid-turn computer escalation with crash-safe handoff.

A computerless worker that reaches a computer tool must commit the
pending call, enqueue a computer-capable continuation, and relinquish
the turn fence before another attempt may execute. Computer ownership is
a lease. Recovery continues unresolved work exactly once or ends the
turn visibly. It never runs the computer action twice.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum


class EscalationBoundary(StrEnum):
    """Crash windows on the computer-handoff path."""

    BEFORE_TOOL_CALL_COMMITTED = "before the tool call is committed"
    AFTER_COMMIT_BEFORE_ENQUEUE = "after the tool call is committed but before enqueue"
    AFTER_ENQUEUE_BEFORE_RELINQUISH = "after enqueue but before relinquishing ownership"
    AFTER_ACTION_BEFORE_RESULT = (
        "after the computer action but before its result is committed"
    )
    AFTER_COMPUTER_LEASE_EXPIRED = "after the computer lease expired before reclamation"


HANDOFF_BOUNDARIES = (
    EscalationBoundary.BEFORE_TOOL_CALL_COMMITTED,
    EscalationBoundary.AFTER_COMMIT_BEFORE_ENQUEUE,
    EscalationBoundary.AFTER_ENQUEUE_BEFORE_RELINQUISH,
    EscalationBoundary.AFTER_ACTION_BEFORE_RESULT,
)
STRUCTURED_HANDOFF_BOUNDARIES = HANDOFF_BOUNDARIES + (
    EscalationBoundary.AFTER_COMPUTER_LEASE_EXPIRED,
)


@dataclass
class PendingComputerToolCall:
    """One computer tool request on a turn."""

    action_id: str
    tool_name: str
    arguments: dict[str, str]


@dataclass
class ComputerOwnershipClaim:
    """Exclusive lease on one household computer."""

    computer_id: str
    turn_id: str
    attempt_id: str
    worker_id: str
    expires_at: datetime


@dataclass
class EscalationRecord:
    """Durable handoff state for one turn."""

    turn_id: str
    tenant_id: str
    user_id: str
    computer_id: str
    pending_call: PendingComputerToolCall
    call_committed: bool = False
    continuation_enqueued: bool = False
    computerless_relinquished: bool = False
    computer_action_count: int = 0
    result_committed: bool = False
    continuation_job_id: str | None = None
    result_body: str | None = None
    executed_action_id: str | None = None
    computerless_output: str | None = None
    continuation_output: str | None = None
    result_replay_attempts: int = 0


class EscalationCrash(Exception):
    """Raised when a handoff driver stops at a named boundary."""

    def __init__(self, boundary: EscalationBoundary) -> None:
        self.boundary = boundary
        super().__init__(f"escalation crash {boundary}")
