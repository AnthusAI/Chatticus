"""Turn-triggered deadlines and recovery without an always-on reaper.

Recovery scheduling is an in-memory kernel hook used by unit and behavior
tests. Production wiring waits on an EventBridge-backed
``TurnDeadlineScheduler``; ``plane_from_env()`` does not enable recovery
until that transport exists. Logical-enqueue dedup is durable in
``DynamoMessagingStore`` via conditional writes on the turn item.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol


class TurnDeadlineScheduler(Protocol):
    """Schedule one watchdog per started turn."""

    def schedule(self, tenant_id: str, turn_id: str, deadline_at: datetime) -> None:
        """Record when a turn should be checked for recovery."""

    def cancel(self, tenant_id: str, turn_id: str) -> None:
        """Drop a pending watchdog when a turn finishes."""


@dataclass(frozen=True)
class ScheduledTurnDeadline:
    """One pending turn watchdog."""

    tenant_id: str
    turn_id: str
    deadline_at: datetime


class InMemoryTurnDeadlineScheduler:
    """Test scheduler that fires when the control-plane clock advances."""

    def __init__(
        self,
        on_deadline: Callable[[str, str], None],
    ) -> None:
        self._on_deadline = on_deadline
        self._deadlines: dict[tuple[str, str], datetime] = {}

    def schedule(self, tenant_id: str, turn_id: str, deadline_at: datetime) -> None:
        """Record when a turn should be checked for recovery."""
        self._deadlines[(tenant_id, turn_id)] = deadline_at

    def cancel(self, tenant_id: str, turn_id: str) -> None:
        """Drop a pending watchdog when a turn finishes."""
        self._deadlines.pop((tenant_id, turn_id), None)

    def check_deadlines(self, now: datetime) -> None:
        """Fire every deadline at or before ``now``."""
        due = [
            key for key, deadline_at in self._deadlines.items() if deadline_at <= now
        ]
        for tenant_id, turn_id in due:
            self._deadlines.pop((tenant_id, turn_id), None)
            self._on_deadline(tenant_id, turn_id)


class LogicalEnqueueLedger:
    """Track logical enqueue ids so retries do not duplicate delivery."""

    def __init__(self) -> None:
        self._recorded: set[tuple[str, str]] = set()
        self._delivery_count = 0

    def record_delivery(self, tenant_id: str, enqueue_id: str) -> bool:
        """Return True when this is the first delivery for ``enqueue_id``."""
        key = (tenant_id, enqueue_id)
        if key in self._recorded:
            return False
        self._recorded.add(key)
        self._delivery_count += 1
        return True

    @property
    def delivery_count(self) -> int:
        """Return how many distinct logical enqueues were delivered."""
        return self._delivery_count


class QueueVisibilityLedger:
    """Record SQS visibility renewals for behavior specs."""

    def __init__(self) -> None:
        self.renewals: list[tuple[str, str]] = []

    def renew(self, tenant_id: str, turn_id: str) -> None:
        """Record one visibility extension."""
        self.renewals.append((tenant_id, turn_id))


def logical_enqueue_id(turn_id: str, *, recovery_attempt: int | None = None) -> str:
    """Build a stable id for one logical queue delivery."""
    if recovery_attempt is None:
        return f"{turn_id}#initial"
    return f"{turn_id}#recovery-{recovery_attempt}"
