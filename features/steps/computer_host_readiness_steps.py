"""Behave steps for computer host readiness."""

from __future__ import annotations

from behave import then, when

from chatticus.computer_capabilities import BROWSER_CAPABILITY
from chatticus.computer_host_readiness_driver import ComputerHostReadinessDriver


@when("the computer host finishes booting through model and workspace gates")
def when_host_boots_through_workspace(context: object) -> None:
    context.host_readiness = ComputerHostReadinessDriver(context.plane)
    context.host_readiness.given_stopped_computer()
    context.host_readiness.boot_through_workspace()


@then("model readiness is recorded before browser readiness")
def then_model_before_browser(context: object) -> None:
    readiness = context.host_readiness.readiness()
    assert readiness.is_ready("model") is True
    assert readiness.is_ready("workspace") is True
    assert readiness.is_ready("browser") is False
    order = context.host_readiness.readiness_order
    assert order.index("model") < order.index("workspace")


@then("browser readiness is not recorded until the browser gate clears")
def then_browser_not_ready_until_cleared(context: object) -> None:
    readiness = context.host_readiness.readiness()
    assert readiness.is_ready(BROWSER_CAPABILITY) is False
    context.host_readiness.clear_browser_gate()
    readiness = context.host_readiness.readiness()
    assert readiness.is_ready(BROWSER_CAPABILITY) is True
