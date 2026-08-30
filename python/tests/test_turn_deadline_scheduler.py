"""Tests for EventBridge Scheduler turn-deadline transport."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from chatticus.deadline.lambda_handler import handler
from chatticus.deadline.scheduler import (
    EventBridgeTurnDeadlineScheduler,
    FakeTurnDeadlineScheduler,
    format_scheduler_at,
    turn_deadline_schedule_name,
)
from chatticus.runtime import plane_from_env


def test_schedule_name_is_stable_and_short() -> None:
    name = turn_deadline_schedule_name("anthus", "turn-abc")
    again = turn_deadline_schedule_name("anthus", "turn-abc")
    assert name == again
    assert name.startswith("turn-")
    assert len(name) <= 64


def test_format_scheduler_at_uses_utc() -> None:
    moment = datetime(2026, 8, 30, 12, 30, 45, tzinfo=UTC)
    assert format_scheduler_at(moment) == "2026-08-30T12:30:45"


def test_fake_scheduler_records_schedule_and_cancel() -> None:
    scheduler = FakeTurnDeadlineScheduler()
    moment = datetime(2026, 8, 30, 12, 0, tzinfo=UTC)
    scheduler.schedule("anthus", "turn-1", moment)
    scheduler.cancel("anthus", "turn-1")
    assert scheduler.cancelled == [("anthus", "turn-1")]
    assert scheduler.schedules == []


class _FakeSchedulerClient:
    class exceptions:
        class ResourceNotFoundException(Exception):
            pass

        class ConflictException(Exception):
            pass

    def __init__(self) -> None:
        self.created: list[dict[str, object]] = []
        self.updated: list[dict[str, object]] = []
        self.deleted: list[tuple[str, str]] = []

    def create_schedule(self, **kwargs: object) -> None:
        name = kwargs["Name"]
        if any(entry["Name"] == name for entry in self.created):
            raise self.exceptions.ConflictException(name)
        self.created.append(kwargs)

    def update_schedule(self, **kwargs: object) -> None:
        self.updated.append(kwargs)

    def delete_schedule(self, Name: str, GroupName: str) -> None:
        self.deleted.append((Name, GroupName))


def test_eventbridge_scheduler_create_and_cancel() -> None:
    client = _FakeSchedulerClient()
    scheduler = EventBridgeTurnDeadlineScheduler(
        "chatticus-development-turn-deadlines",
        "arn:aws:lambda:us-east-1:123:function:deadline",
        "arn:aws:iam::123:role/scheduler",
        client=client,
    )
    moment = datetime(2026, 8, 30, 15, 0, tzinfo=UTC)
    scheduler.schedule("anthus", "turn-42", moment)
    name = turn_deadline_schedule_name("anthus", "turn-42")
    assert client.created[0]["Name"] == name
    assert client.created[0]["ScheduleExpression"] == "at(2026-08-30T15:00:00)"
    assert client.created[0]["ActionAfterCompletion"] == "DELETE"
    scheduler.cancel("anthus", "turn-42")
    assert client.deleted == [(name, "chatticus-development-turn-deadlines")]


def test_eventbridge_scheduler_updates_on_conflict() -> None:
    client = _FakeSchedulerClient()
    scheduler = EventBridgeTurnDeadlineScheduler(
        "group",
        "arn:aws:lambda:us-east-1:123:function:deadline",
        "arn:aws:iam::123:role/scheduler",
        client=client,
    )
    first = datetime(2026, 8, 30, 15, 0, tzinfo=UTC)
    second = datetime(2026, 8, 30, 16, 0, tzinfo=UTC)
    scheduler.schedule("anthus", "turn-42", first)
    scheduler.schedule("anthus", "turn-42", second)
    assert len(client.created) == 1
    assert client.updated[0]["ScheduleExpression"] == "at(2026-08-30T16:00:00)"


def test_eventbridge_scheduler_cancel_ignores_missing_schedule() -> None:
    client = _FakeSchedulerClient()
    scheduler = EventBridgeTurnDeadlineScheduler(
        "group",
        "arn:aws:lambda:us-east-1:123:function:deadline",
        "arn:aws:iam::123:role/scheduler",
        client=client,
    )
    scheduler.cancel("anthus", "missing")


def test_plane_from_env_enables_recovery_with_scheduler_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    monkeypatch.setenv("CHATTICUS_MESSAGING_TABLE", "Messaging")
    monkeypatch.setenv("CHATTICUS_TURN_DEADLINE_SCHEDULE_GROUP", "deadlines")
    monkeypatch.setenv(
        "CHATTICUS_TURN_DEADLINE_TARGET_ARN",
        "arn:aws:lambda:us-east-1:123:function:deadline",
    )
    monkeypatch.setenv(
        "CHATTICUS_TURN_DEADLINE_ROLE_ARN",
        "arn:aws:iam::123:role/scheduler",
    )
    plane = plane_from_env()
    assert plane.recovery_enabled
    from chatticus.deadline.scheduler import EventBridgeTurnDeadlineScheduler

    assert isinstance(plane._deadline_scheduler, EventBridgeTurnDeadlineScheduler)


def test_plane_from_env_recovery_stays_off_without_scheduler(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    monkeypatch.setenv("CHATTICUS_MESSAGING_TABLE", "Messaging")
    monkeypatch.delenv("CHATTICUS_TURN_DEADLINE_SCHEDULE_GROUP", raising=False)
    plane = plane_from_env()
    assert not plane.recovery_enabled


def test_deadline_lambda_handler_invokes_plane(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, str]] = []

    class FakePlane:
        def handle_turn_deadline(self, tenant_id: str, turn_id: str) -> None:
            calls.append((tenant_id, turn_id))

    monkeypatch.setattr(
        "chatticus.deadline.lambda_handler.plane_from_env",
        lambda: FakePlane(),
    )
    handler({"tenant_id": "anthus", "turn_id": "turn-9"}, None)
    assert calls == [("anthus", "turn-9")]
