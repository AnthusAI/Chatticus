"""Kernel tests for paths the Gherkin narrative does not spell out."""

from __future__ import annotations

from datetime import timedelta

import pytest

from chatticus.control_plane import ControlPlane
from chatticus.models import (
    CONSEQUENTIAL_ACTION_TYPES,
    ApprovalDecision,
    ComputerPolicy,
    CostClass,
    WorkerRegistration,
)


def _worker(
    worker_id: str,
    *,
    tenant_id: str = "anthus",
    cost_class: CostClass = CostClass.LOCAL,
    capabilities: frozenset[str] | None = None,
    computer_id: str | None = None,
) -> WorkerRegistration:
    return WorkerRegistration(
        worker_id=worker_id,
        tenant_id=tenant_id,
        cost_class=cost_class,
        capabilities=capabilities or frozenset({"computer"}),
        computer_id=computer_id,
    )


def test_heartbeat_on_unknown_worker_raises() -> None:
    plane = ControlPlane()
    with pytest.raises(KeyError):
        plane.heartbeat("missing")


def test_computer_for_unknown_user_raises() -> None:
    plane = ControlPlane()
    with pytest.raises(KeyError):
        plane.computer_for_user("anthus", "ryan")


def test_remember_on_unknown_bot_raises() -> None:
    plane = ControlPlane()
    with pytest.raises(KeyError):
        plane.remember("missing", "voice", "short")


def test_heartbeat_at_exact_timeout_is_still_healthy() -> None:
    plane = ControlPlane(heartbeat_timeout=timedelta(seconds=30))
    plane.register_worker(_worker("garage-mac-1"))
    plane.advance_seconds(30)
    assert len(plane.healthy_workers("anthus")) == 1
    plane.advance_seconds(0.001)
    assert len(plane.healthy_workers("anthus")) == 0


def test_newer_heartbeat_wins_among_same_cost_class() -> None:
    plane = ControlPlane()
    plane.register_worker(_worker("mac-a", computer_id="a"))
    plane.advance_seconds(1)
    plane.register_worker(_worker("mac-b", computer_id="b"))
    job = plane.enqueue_turn("anthus", frozenset({"computer"}))
    assigned = plane.assign_turn(job)
    assert assigned is not None
    assert assigned.worker_id == "mac-b"


def test_ensure_computer_is_idempotent() -> None:
    plane = ControlPlane()
    first = plane.ensure_computer("anthus", "ryan")
    second = plane.ensure_computer("anthus", "ryan")
    assert first.computer_id == second.computer_id


def test_pinned_turn_ignores_worker_without_computer_id() -> None:
    plane = ControlPlane()
    plane.register_worker(_worker("unpinned"))
    job = plane.enqueue_turn(
        "anthus",
        frozenset({"computer"}),
        computer_id="household-computer",
    )
    assert plane.assign_turn(job) is None


def test_aws_only_with_only_local_is_unassigned() -> None:
    plane = ControlPlane()
    plane.register_worker(_worker("garage-mac-1"))
    job = plane.enqueue_turn(
        "anthus",
        frozenset({"computer"}),
        computer_policy=ComputerPolicy.AWS_ONLY,
    )
    assert plane.assign_turn(job) is None


def test_every_consequential_action_requires_approval_by_default() -> None:
    plane = ControlPlane()
    for action_type in CONSEQUENTIAL_ACTION_TYPES:
        assert plane.evaluate_action(action_type) == ApprovalDecision.REQUIRE_APPROVAL
