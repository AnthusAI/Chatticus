"""Kernel tests for crash-safe computer escalation."""

from __future__ import annotations

import pytest

from chatticus.control_plane import ControlPlane
from chatticus.escalation_driver import EscalationHandoffDriver
from chatticus.escalation_handoff import (
    HANDOFF_BOUNDARIES,
    EscalationBoundary,
    EscalationCrash,
)
from chatticus.models import TurnStatus


@pytest.mark.parametrize("boundary", HANDOFF_BOUNDARIES)
def test_handoff_crash_recovers_without_duplicate_computer_action(
    boundary: EscalationBoundary,
) -> None:
    driver = EscalationHandoffDriver()
    driver.given_ready_to_request_computer_tool()
    with pytest.raises(EscalationCrash):
        driver.crash_at(boundary)
    outcome = driver.recover()
    assert outcome.computer_action_count == 1
    assert outcome.pending_continued_once
    assert outcome.ended_visibly
    assert outcome.turn_status == TurnStatus.COMPLETED
    assert len(outcome.computer_controllers) <= 1
    assert outcome.orphan_claim_expired is True


def test_computer_action_is_not_repeated_after_result_gap() -> None:
    plane = ControlPlane()
    driver = EscalationHandoffDriver(plane)
    driver.given_ready_to_request_computer_tool()
    with pytest.raises(EscalationCrash):
        driver.crash_at(EscalationBoundary.AFTER_ACTION_BEFORE_RESULT)
    assert driver.turn_id is not None
    record = plane.escalation_for(driver.tenant_id, driver.turn_id)
    assert record.computer_action_count == 1
    assert record.result_committed is False
    plane.recover_computer_escalation(driver.tenant_id, driver.turn_id)
    assert record.computer_action_count == 1
    assert record.result_committed is True
    plane.execute_pending_computer_action(driver.tenant_id, driver.turn_id)
    assert record.computer_action_count == 1
