"""EventBridge Scheduler transport for per-turn recovery deadlines."""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import UTC, datetime

from chatticus.turn_recovery import ScheduledTurnDeadline

logger = logging.getLogger("chatticus.deadline")


def turn_deadline_schedule_name(tenant_id: str, turn_id: str) -> str:
    """Return a stable Scheduler name for one tenant turn."""
    digest = hashlib.sha256(f"{tenant_id}:{turn_id}".encode()).hexdigest()[:32]
    return f"turn-{digest}"


def format_scheduler_at(deadline_at: datetime) -> str:
    """Format a UTC instant for EventBridge Scheduler ``at()`` expressions."""
    moment = deadline_at.astimezone(UTC).replace(microsecond=0)
    return moment.strftime("%Y-%m-%dT%H:%M:%S")


class EventBridgeTurnDeadlineScheduler:
    """One-shot EventBridge Scheduler schedule per active turn."""

    def __init__(
        self,
        schedule_group: str,
        target_arn: str,
        role_arn: str,
        *,
        client: object | None = None,
    ) -> None:
        self._schedule_group = schedule_group
        self._target_arn = target_arn
        self._role_arn = role_arn
        if client is None:
            import boto3

            self._client = boto3.client("scheduler")
        else:
            self._client = client

    def schedule(self, tenant_id: str, turn_id: str, deadline_at: datetime) -> None:
        """Create or update the one-shot watchdog for one turn."""
        name = turn_deadline_schedule_name(tenant_id, turn_id)
        payload = json.dumps({"tenant_id": tenant_id, "turn_id": turn_id})
        expression = f"at({format_scheduler_at(deadline_at)})"
        request = {
            "Name": name,
            "GroupName": self._schedule_group,
            "ScheduleExpression": expression,
            "ScheduleExpressionTimezone": "UTC",
            "FlexibleTimeWindow": {"Mode": "OFF"},
            "Target": {
                "Arn": self._target_arn,
                "RoleArn": self._role_arn,
                "Input": payload,
            },
            "ActionAfterCompletion": "DELETE",
        }
        try:
            self._client.create_schedule(**request)
        except self._client.exceptions.ConflictException:
            self._client.update_schedule(**request)
        logger.info(
            "turn_deadline_scheduled tenant_id=%s turn_id=%s at=%s",
            tenant_id,
            turn_id,
            expression,
        )

    def cancel(self, tenant_id: str, turn_id: str) -> None:
        """Delete a pending watchdog when a turn finishes."""
        name = turn_deadline_schedule_name(tenant_id, turn_id)
        try:
            self._client.delete_schedule(Name=name, GroupName=self._schedule_group)
            logger.info(
                "turn_deadline_cancelled tenant_id=%s turn_id=%s",
                tenant_id,
                turn_id,
            )
        except self._client.exceptions.ResourceNotFoundException:
            return


class FakeTurnDeadlineScheduler:
    """Test double that records schedule/cancel without AWS."""

    def __init__(self) -> None:
        self.schedules: list[ScheduledTurnDeadline] = []
        self.cancelled: list[tuple[str, str]] = []

    def schedule(self, tenant_id: str, turn_id: str, deadline_at: datetime) -> None:
        """Record one pending watchdog."""
        self.schedules = [
            entry
            for entry in self.schedules
            if (entry.tenant_id, entry.turn_id) != (tenant_id, turn_id)
        ]
        self.schedules.append(
            ScheduledTurnDeadline(
                tenant_id=tenant_id,
                turn_id=turn_id,
                deadline_at=deadline_at,
            )
        )

    def cancel(self, tenant_id: str, turn_id: str) -> None:
        """Record one cancellation."""
        self.cancelled.append((tenant_id, turn_id))
        self.schedules = [
            entry
            for entry in self.schedules
            if (entry.tenant_id, entry.turn_id) != (tenant_id, turn_id)
        ]
