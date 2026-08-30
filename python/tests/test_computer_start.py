"""Kernel tests for a single shared computer start."""

from __future__ import annotations

from chatticus.computer_start_driver import SingleComputerStartDriver
from chatticus.control_plane import ControlPlane


def test_two_concurrent_turns_issue_one_host_start() -> None:
    plane = ControlPlane()
    driver = SingleComputerStartDriver(plane)
    driver.given_stopped_computer()
    outcome = driver.request_two_turns_concurrently()
    assert outcome.host_start_count == 1
    assert len(set(outcome.computer_ids)) == 1
    assert len(outcome.waiting_turn_ids) == 2
    assert outcome.write_host_a is True
    assert outcome.write_host_b is False
    assert outcome.live_writer_host_id == "host-a"
