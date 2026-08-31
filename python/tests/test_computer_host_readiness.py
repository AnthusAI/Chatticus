"""Kernel tests for computer host readiness recording."""

from __future__ import annotations

from chatticus.computer_capabilities import (
    BROWSER_CAPABILITY,
    MODEL_CAPABILITY,
    WORKSPACE_CAPABILITY,
)
from chatticus.computer_host_readiness_driver import ComputerHostReadinessDriver


def test_capability_readiness_records_independently() -> None:
    driver = ComputerHostReadinessDriver()
    driver.given_stopped_computer()
    readiness = driver.readiness()
    assert readiness.is_ready(MODEL_CAPABILITY) is False
    assert readiness.is_ready(WORKSPACE_CAPABILITY) is False
    assert readiness.is_ready(BROWSER_CAPABILITY) is False
    driver.boot_through_workspace()
    readiness = driver.readiness()
    assert readiness.is_ready(MODEL_CAPABILITY) is True
    assert readiness.is_ready(WORKSPACE_CAPABILITY) is True
    assert readiness.is_ready(BROWSER_CAPABILITY) is False
    driver.clear_browser_gate()
    readiness = driver.readiness()
    assert readiness.is_ready(BROWSER_CAPABILITY) is True
