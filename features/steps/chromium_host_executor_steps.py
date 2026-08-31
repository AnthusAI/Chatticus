"""Behave steps for the Chromium host executor."""

from __future__ import annotations

from unittest.mock import patch

from behave import given, then, when

from chatticus.chromium_action_executor import ChromiumActionExecutor
from chatticus.computer_host_boot import ComputerHostBootDriver
from chatticus.http.client import HttpTurnClient
from chatticus.worker.computer import ComputerWorker


@given("the computer host has booted through the browser gate")
def given_host_booted_through_browser(context: object) -> None:
    driver = ComputerHostBootDriver(context.plane)
    with patch.object(driver._xvfb, "start"), patch(
        "chatticus.computer_host_boot.verify_chromium_available",
        return_value="Chromium 120.0.0.0",
    ):
        context.host_boot = driver.boot_through_browser()


@when(
    "a computer-capable pull worker with a chromium executor pulls that continuation job"
)
def when_worker_pulls_with_chromium_executor(context: object) -> None:
    setup = context.computer_continuation
    executor = ChromiumActionExecutor(display=":99")
    with patch.object(
        executor,
        "execute",
        return_value="opened",
    ) as execute:
        context.chromium_execute = execute
        ComputerWorker(
            context.plane,
            HttpTurnClient(context.api_client, setup.tenant_id),
            action_executor=executor,
        ).run_job(setup.continuation_job)


@when("a chromium executor runs an unsupported browser tool")
def when_chromium_executor_runs_unsupported_tool(context: object) -> None:
    executor = ChromiumActionExecutor(display=":99")
    context.chromium_executor_error = None
    try:
        executor.execute("browser_click", {"selector": "button"})
    except ValueError as exc:
        context.chromium_executor_error = exc


@then("the chromium executor reports the tool is unsupported")
def then_chromium_executor_reports_unsupported(context: object) -> None:
    error = context.chromium_executor_error
    assert error is not None
    assert "does not support" in str(error)
