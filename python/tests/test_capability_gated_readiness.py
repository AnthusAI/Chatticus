"""Kernel tests for capability-gated readiness."""

from __future__ import annotations

from chatticus.capability_gated_readiness import CapabilityGatedTurnDriver
from chatticus.computer_capabilities import (
    BROWSER_CAPABILITY,
    ComputerCapabilityReadiness,
)
from chatticus.models import TurnEventKind


def test_computerless_work_precedes_browser_waiting() -> None:
    driver = CapabilityGatedTurnDriver()
    driver.given_stopped_computer()
    driver.given_preparatory_then_browser_work(
        preparatory_output="Draft summary before browsing."
    )
    state = driver.begin_turn()
    assert state.preparatory_output == "Draft summary before browsing."
    assert state.waiting_for == BROWSER_CAPABILITY
    assert driver.preparatory_emitted_before_waiting()
    events = driver.plane.list_turn_events(driver.tenant_id, state.turn_id)
    kinds = [event.kind for event in events]
    token_index = kinds.index(TurnEventKind.TURN_TOKEN)
    waiting_index = kinds.index(TurnEventKind.TURN_WAITING)
    assert token_index < waiting_index


def test_same_turn_continues_after_browser_ready() -> None:
    driver = CapabilityGatedTurnDriver()
    driver.given_stopped_computer()
    driver.given_preparatory_then_browser_work()
    begin = driver.begin_turn()
    driver.mark_computer_ready()
    continued = driver.continue_turn()
    assert continued.continued_same_turn is True
    assert continued.completed_turn_id == begin.turn_id
    assert driver.turn_completed() is True


def test_readiness_tracks_independent_capabilities() -> None:
    readiness = ComputerCapabilityReadiness(
        model_ready=True,
        workspace_ready=False,
        browser_ready=False,
    )
    assert readiness.is_ready("model") is True
    assert readiness.is_ready("workspace") is False
    assert readiness.is_ready("browser") is False
