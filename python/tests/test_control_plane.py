"""Kernel tests for paths the Gherkin narrative does not spell out."""

from __future__ import annotations

import time
from datetime import timedelta

import pytest

from chatticus.control_plane import ControlPlane
from chatticus.models import (
    CONSEQUENTIAL_ACTION_TYPES,
    ApprovalDecision,
    AutoReviewRuleKind,
    ComputerDirtyError,
    ComputerNotHydratedError,
    ComputerPolicy,
    CostClass,
    DuplicateBotNameError,
    SnapshotRequiredError,
    WorkerDoesNotHostComputerError,
    WorkerRegistration,
    WorkerTenantMismatchError,
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


def test_wall_clock_plane_does_not_freeze() -> None:
    plane = ControlPlane(wall_clock=True)
    first = plane.now()
    time.sleep(0.02)
    assert plane.now() > first


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
        assert (
            plane.evaluate_action(action_type, "anthus")
            == ApprovalDecision.REQUIRE_APPROVAL
        )


def test_auto_review_rules_are_tenant_scoped() -> None:
    plane = ControlPlane()
    plane.add_auto_review_rule(
        AutoReviewRuleKind.NEVER_ALLOW, "send", "other-household"
    )
    assert plane.evaluate_action("send", "anthus") == ApprovalDecision.REQUIRE_APPROVAL
    assert plane.evaluate_action("send", "other-household") == ApprovalDecision.DENY


def test_worker_cannot_change_tenant_by_re_registering() -> None:
    plane = ControlPlane()
    plane.register_worker(_worker("garage-mac-1", tenant_id="anthus"))
    with pytest.raises(WorkerTenantMismatchError):
        plane.register_worker(_worker("garage-mac-1", tenant_id="other-household"))
    assert plane.worker("garage-mac-1").registration.tenant_id == "anthus"


def test_duplicate_bot_name_for_one_user_is_rejected() -> None:
    plane = ControlPlane()
    plane.create_bot("anthus", "ryan", "Researcher")
    with pytest.raises(DuplicateBotNameError):
        plane.create_bot("anthus", "ryan", "Researcher")


def test_bot_turn_pins_to_the_user_computer() -> None:
    plane = ControlPlane()
    computer = plane.ensure_computer("anthus", "ryan", computer_id="household-computer")
    bot = plane.create_bot("anthus", "ryan", "Researcher")
    plane.register_worker(_worker("garage-mac-1", computer_id="household-computer"))
    job = plane.enqueue_turn(
        "anthus",
        frozenset({"computer"}),
        bot_id=bot.bot_id,
    )
    assert job.computer_id == computer.computer_id
    assigned = plane.assign_turn(job)
    assert assigned is not None
    assert assigned.worker_id == "garage-mac-1"


def test_computer_by_unknown_id_raises() -> None:
    plane = ControlPlane()
    with pytest.raises(KeyError):
        plane.computer_by_id("missing")


def test_publish_snapshot_copies_disk_into_object_storage() -> None:
    plane = ControlPlane()
    computer = plane.ensure_computer("anthus", "ryan", computer_id="household-computer")
    plane.register_worker(_worker("fargate-1", computer_id="household-computer"))
    plane.write_workspace("anthus", "ryan", "notes.md", "weekly")
    record = plane.publish_snapshot("household-computer", "fargate-1")
    assert record.snapshot_uri == plane.snapshot_uri_for(computer)
    assert record.workspace["notes.md"] == "weekly"
    assert record.published_by_worker_id == "fargate-1"
    stored = plane.snapshot(record.snapshot_uri)
    assert stored.checksum == computer.snapshot_checksum
    assert computer.disk_dirty is False


def test_relocate_without_snapshot_raises() -> None:
    plane = ControlPlane()
    plane.ensure_computer("anthus", "ryan", computer_id="household-computer")
    plane.register_worker(_worker("garage-mac-1", computer_id="household-computer"))
    with pytest.raises(SnapshotRequiredError):
        plane.relocate_computer("household-computer", "garage-mac-1")


def test_dirty_disk_blocks_relocate() -> None:
    plane = ControlPlane()
    plane.ensure_computer("anthus", "ryan", computer_id="household-computer")
    plane.register_worker(_worker("fargate-1", computer_id="household-computer"))
    plane.register_worker(_worker("garage-mac-1", computer_id="household-computer"))
    plane.write_workspace("anthus", "ryan", "notes.md", "weekly")
    plane.publish_snapshot("household-computer", "fargate-1")
    plane.write_workspace("anthus", "ryan", "notes.md", "unsynced")
    with pytest.raises(ComputerDirtyError):
        plane.relocate_computer("household-computer", "garage-mac-1")


def test_hydrate_restores_published_disk() -> None:
    plane = ControlPlane()
    plane.ensure_computer("anthus", "ryan", computer_id="household-computer")
    plane.register_worker(_worker("fargate-1", computer_id="household-computer"))
    plane.register_worker(_worker("garage-mac-1", computer_id="household-computer"))
    plane.write_workspace("anthus", "ryan", "notes.md", "published")
    plane.publish_snapshot("household-computer", "fargate-1")
    plane.relocate_computer("household-computer", "garage-mac-1")
    plane.hydrate_computer("household-computer", "garage-mac-1")
    assert plane.read_workspace("anthus", "ryan", "notes.md") == "published"


def test_wrong_host_cannot_publish_or_hydrate() -> None:
    plane = ControlPlane()
    plane.ensure_computer("anthus", "ryan", computer_id="household-computer")
    plane.register_worker(_worker("fargate-1", computer_id="household-computer"))
    plane.register_worker(_worker("other-mac", computer_id="other-computer"))
    plane.write_workspace("anthus", "ryan", "notes.md", "weekly")
    with pytest.raises(WorkerDoesNotHostComputerError):
        plane.publish_snapshot("household-computer", "other-mac")
    plane.publish_snapshot("household-computer", "fargate-1")
    with pytest.raises(WorkerDoesNotHostComputerError):
        plane.relocate_computer("household-computer", "other-mac")
    plane.register_worker(_worker("garage-mac-1", computer_id="household-computer"))
    plane.relocate_computer("household-computer", "garage-mac-1")
    with pytest.raises(WorkerDoesNotHostComputerError):
        plane.hydrate_computer("household-computer", "fargate-1")
    with pytest.raises(WorkerDoesNotHostComputerError):
        plane.hydrate_computer("household-computer", "other-mac")


def test_publish_while_hydrate_required_raises() -> None:
    plane = ControlPlane()
    plane.ensure_computer("anthus", "ryan", computer_id="household-computer")
    plane.register_worker(_worker("fargate-1", computer_id="household-computer"))
    plane.register_worker(_worker("garage-mac-1", computer_id="household-computer"))
    plane.write_workspace("anthus", "ryan", "notes.md", "weekly")
    plane.publish_snapshot("household-computer", "fargate-1")
    plane.relocate_computer("household-computer", "garage-mac-1")
    with pytest.raises(ComputerNotHydratedError):
        plane.publish_snapshot("household-computer", "garage-mac-1")
    with pytest.raises(ComputerNotHydratedError):
        plane.save_browser_session("anthus", "ryan", "salesforce", "signed-in")


def test_hydrate_without_snapshot_raises() -> None:
    plane = ControlPlane()
    plane.ensure_computer("anthus", "ryan", computer_id="household-computer")
    plane.register_worker(_worker("garage-mac-1", computer_id="household-computer"))
    with pytest.raises(SnapshotRequiredError):
        plane.hydrate_computer("household-computer", "garage-mac-1")


def test_unknown_snapshot_uri_raises() -> None:
    plane = ControlPlane()
    with pytest.raises(KeyError):
        plane.snapshot("s3://chatticus/missing")
