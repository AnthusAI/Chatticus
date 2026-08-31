"""Kernel tests for a single shared computer start."""

from __future__ import annotations

from chatticus.computer_start_driver import SingleComputerStartDriver
from chatticus.control_plane import ControlPlane
from chatticus.models import CostClass, WorkerRegistration


def test_two_concurrent_turns_issue_one_host_start() -> None:
    plane = ControlPlane()
    driver = SingleComputerStartDriver(plane)
    driver.computer_id = None
    driver.given_stopped_computer()
    outcome = driver.request_two_turns_concurrently()
    assert outcome.host_start_count == 1
    assert len(set(outcome.computer_ids)) == 1
    assert len(outcome.waiting_turn_ids) == 2
    assert outcome.write_host_a is True
    assert outcome.write_host_b is False
    assert outcome.live_writer_host_id == "host-a"


def test_retry_shares_one_host_start_claim() -> None:
    plane = ControlPlane()
    driver = SingleComputerStartDriver(plane)
    driver.computer_id = None
    driver.given_stopped_computer()
    driver.request_host_start()
    driver.retry_host_start()
    assert driver.host_start_count() == 1


def test_expired_claim_can_be_reclaimed() -> None:
    plane = ControlPlane()
    driver = SingleComputerStartDriver(plane)
    driver.computer_id = None
    driver.given_stopped_computer()
    driver.request_host_start()
    driver.expire_host_start_lease()
    driver._last_turn_id = None
    driver.request_host_start()
    assert driver.host_start_count() == 2
    assert driver.disk_write_lock_held() is False


def test_stale_local_host_loses_prefer_local_until_reconciled() -> None:
    plane = ControlPlane()
    driver = SingleComputerStartDriver(plane)
    driver.given_stopped_computer()
    plane.register_worker(
        WorkerRegistration(
            worker_id="garage-mac-1",
            tenant_id="anthus",
            cost_class=CostClass.LOCAL,
            capabilities=frozenset({"computer"}),
            computer_id="household-computer",
        )
    )
    plane.register_worker(
        WorkerRegistration(
            worker_id="fargate-1",
            tenant_id="anthus",
            cost_class=CostClass.FARGATE,
            capabilities=frozenset({"computer"}),
            computer_id="household-computer",
        )
    )
    driver.set_local_reconciled_generation(1)
    driver.publish_remote_snapshot_generation(2)
    assert driver.select_start_host() == "fargate-1"
    driver.reconcile_local_host(2)
    assert driver.select_start_host() == "garage-mac-1"
