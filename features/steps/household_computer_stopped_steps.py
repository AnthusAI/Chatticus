"""Behave step the host-side computer features share: the computer is stopped."""

from __future__ import annotations

from behave import given

from chatticus.capability_gated_readiness import CapabilityGatedTurnDriver


@given("the household computer is stopped")
def given_computer_stopped(context: object) -> None:
    context.capability_driver = CapabilityGatedTurnDriver(context.plane)
    context.capability_driver.given_stopped_computer()
