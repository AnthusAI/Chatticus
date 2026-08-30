"""Deterministic crash windows around every durable turn boundary."""

from __future__ import annotations

import pytest

from chatticus.models import TurnStatus
from chatticus.turn_fault_hooks import CrashWindow, TurnBoundary
from chatticus.turn_fault_injection import (
    ALL_CRASH_SCENARIOS,
    TurnFaultDriver,
)


@pytest.mark.parametrize(
    ("boundary", "window"),
    ALL_CRASH_SCENARIOS,
    ids=[
        f"{boundary.value}-{window.value}" for boundary, window in ALL_CRASH_SCENARIOS
    ],
)
def test_turn_boundary_crash_recovers_cleanly(
    boundary: TurnBoundary, window: CrashWindow
) -> None:
    driver = TurnFaultDriver()
    try:
        driver.drive_until_crash(boundary, window)
        assert driver.injector.crashed_at == (boundary, window)
        outcome = driver.recover_and_complete(boundary, window)
        assert outcome.provider_calls == 1
        assert outcome.human_messages == 1
        assert outcome.bot_messages == 1
        assert outcome.turn_status == TurnStatus.COMPLETED
        assert len(outcome.authoritative_workers) <= 1
        if boundary == TurnBoundary.DEADLINE_RECOVERY:
            assert outcome.recovery_attempts == 1
    finally:
        driver.close()


def test_no_two_authoritative_actors_after_recovery() -> None:
    driver = TurnFaultDriver()
    try:
        driver.drive_until_crash(TurnBoundary.WORKER_CLAIM, CrashWindow.AFTER)
        driver.recover_and_complete(TurnBoundary.WORKER_CLAIM, CrashWindow.AFTER)
        assert driver.turn_id is not None
        other = driver.plane.claim_turn_attempt(
            driver.tenant_id, driver.turn_id, "worker-b"
        )
        assert other is None or not other.acquired
        owners = driver.outcome().authoritative_workers
        assert len(owners) <= 1
    finally:
        driver.close()
