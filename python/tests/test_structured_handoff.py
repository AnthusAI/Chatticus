"""Kernel tests for durable typed journal computer handoff."""

from __future__ import annotations

import pytest

from chatticus.escalation_handoff import (
    STRUCTURED_HANDOFF_BOUNDARIES,
    EscalationBoundary,
    EscalationCrash,
)
from chatticus.models import TurnEventKind, TurnStatus
from chatticus.structured_handoff_driver import (
    StructuredHandoffDriver,
    journal_has_typed_handoff,
)


def test_happy_path_journal_is_typed_not_token_only() -> None:
    driver = StructuredHandoffDriver()
    driver.given_ready_to_request_computer_tool()
    outcome = driver.finish_happy_path()
    assert journal_has_typed_handoff(outcome.journal_kinds)
    typed = {
        TurnEventKind.MODEL_REQUEST,
        TurnEventKind.TOOL_CALL,
        TurnEventKind.TOOL_RESULT,
        TurnEventKind.ATTEMPT_CLAIMED,
        TurnEventKind.ATTEMPT_RELINQUISHED,
    }
    assert typed.isdisjoint({TurnEventKind.TURN_TOKEN})
    assert outcome.unresolved_action_ids == []
    assert outcome.executed_action_id is not None
    record = driver.plane.escalation_for(driver.tenant_id, driver.turn_id)
    assert outcome.executed_action_id == record.pending_call.action_id
    assert outcome.turn_status == TurnStatus.COMPLETED


@pytest.mark.parametrize("boundary", STRUCTURED_HANDOFF_BOUNDARIES)
def test_structured_crash_recovers_unresolved_calls_only(
    boundary: EscalationBoundary,
) -> None:
    driver = StructuredHandoffDriver()
    driver.given_ready_to_request_computer_tool()
    with pytest.raises(EscalationCrash):
        driver.crash_at(boundary)
    outcome = driver.recover()
    assert outcome.computer_action_count <= 1
    assert outcome.unresolved_action_ids == []
    assert outcome.pending_continued_once or outcome.ended_visibly
    assert len(outcome.computer_controllers) <= 1
    assert outcome.orphan_claim_expired is True
    if boundary is EscalationBoundary.AFTER_COMPUTER_LEASE_EXPIRED:
        assert outcome.computer_reclaimed is True
        assert outcome.computer_action_count == 1


def test_reclaim_does_not_rerun_executed_action() -> None:
    driver = StructuredHandoffDriver()
    driver.given_ready_to_request_computer_tool()
    with pytest.raises(EscalationCrash):
        driver.crash_at(EscalationBoundary.AFTER_COMPUTER_LEASE_EXPIRED)
    record = driver.plane.escalation_for(driver.tenant_id, driver.turn_id)
    assert record.computer_action_count == 1
    assert record.result_committed is False
    outcome = driver.recover()
    assert record.computer_action_count == 1
    assert record.result_committed is True
    assert outcome.computer_reclaimed is True
    driver.plane.execute_pending_computer_action(driver.tenant_id, driver.turn_id)
    assert record.computer_action_count == 1
