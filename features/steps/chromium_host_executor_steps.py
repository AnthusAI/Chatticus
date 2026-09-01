"""Behave steps for the Chromium host executor."""

from __future__ import annotations

import os
import threading
from pathlib import Path
from unittest.mock import patch

from behave import given, then, when
from computer_worker_helpers import CountingComputerActionExecutor

from chatticus.browser_profiles import browser_profile_dir
from chatticus.browser_waiting_continuation_driver import (
    prepare_browser_waiting_continuation,
)
from chatticus.chromium_action_executor import ChromiumActionExecutor
from chatticus.computer_host_boot import ComputerHostBootDriver
from chatticus.http.client import HttpTurnClient
from chatticus.models import TurnEventKind
from chatticus.worker.computer import ComputerWorker


@given("the computer host has booted through the browser gate")
def given_host_booted_through_browser(context: object) -> None:
    driver = ComputerHostBootDriver(context.plane)
    with (
        patch.object(driver._xvfb, "start"),
        patch(
            "chatticus.computer_host_boot.verify_chromium_available",
            return_value="Chromium 120.0.0.0",
        ),
    ):
        context.host_boot = driver.boot_through_browser()


@when(
    "a computer-capable pull worker with a chromium executor pulls that continuation job"  # noqa: E501
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


@given("a browser-waiting turn with a queued continuation job")
def given_browser_waiting_turn_with_continuation(context: object) -> None:
    setup = prepare_browser_waiting_continuation(context.plane)
    context.browser_waiting_continuation = setup
    context.computer_continuation = setup


@given("one computer continuation job is delivered twice")
def given_computer_continuation_job_delivered_twice(context: object) -> None:
    context.duplicate_continuation_job = context.computer_continuation.continuation_job
    context.counting_executor = CountingComputerActionExecutor()


@when(
    "two computer-capable pull workers with a host executor pull that continuation concurrently"  # noqa: E501
)
def when_two_workers_pull_browser_waiting_concurrently(context: object) -> None:
    setup = context.browser_waiting_continuation
    job = context.duplicate_continuation_job
    errors: list[BaseException] = []
    barrier = threading.Barrier(2)

    def pull() -> None:
        worker = ComputerWorker(
            context.plane,
            HttpTurnClient(context.api_client, setup.tenant_id),
            action_executor=context.counting_executor,
        )
        barrier.wait()
        try:
            worker.run_job(job)
        except BaseException as exc:
            errors.append(exc)

    threads = [threading.Thread(target=pull) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert errors == []


@then("the turn journal records exactly one tool.result for the pending action id")
def then_journal_records_exactly_one_tool_result(context: object) -> None:
    setup = context.browser_waiting_continuation
    events = context.plane.list_turn_events(setup.tenant_id, setup.turn_id)
    results = [
        event
        for event in events
        if event.kind == TurnEventKind.TOOL_RESULT
        and event.action_id == setup.pending_action_id
    ]
    assert len(results) == 1
    assert results[0].body == "opened"


@then("the host executor ran the pending action once")
def then_host_executor_ran_once(context: object) -> None:
    assert context.counting_executor.calls == 1


@given(
    "the household computer holds privileged cookies only under the banking browser profile"  # noqa: E501
)
def given_privileged_banking_profile_on_disk(context: object) -> None:
    live_root = Path(context.snapshot_tmpdir) / "computer-live"
    live_root.mkdir(parents=True, exist_ok=True)
    context.chromium_live_root = live_root
    banking_profile = browser_profile_dir(live_root, "privileged:banking")
    cookies = banking_profile / "Default" / "Cookies"
    cookies.parent.mkdir(parents=True, exist_ok=True)
    cookies.write_text("signed-in\n", encoding="utf-8")


@when("a chromium executor opens an untrusted browser page")
def when_chromium_executor_opens_untrusted_page(context: object) -> None:
    live_root = context.chromium_live_root
    executor = ChromiumActionExecutor(display=":99")
    with (
        patch.dict(os.environ, {"CHATTICUS_LIVE_ROOT": str(live_root)}),
        patch(
            "chatticus.chromium_action_executor.chromium_binary_path",
            return_value="/usr/bin/chromium",
        ),
        patch(
            "chatticus.chromium_action_executor.subprocess.run",
        ) as run,
    ):
        run.return_value.returncode = 0
        run.return_value.stdout = "<html></html>"
        run.return_value.stderr = ""
        executor.execute(
            "browser_open",
            {
                "url": "https://untrusted.example/article",
                "storage_partition": "untrusted",
            },
        )
        context.chromium_command = run.call_args.args[0]


@then("the chromium executor used the untrusted browser profile directory")
def then_chromium_used_untrusted_profile(context: object) -> None:
    live_root = context.chromium_live_root
    expected = browser_profile_dir(live_root, "untrusted")
    user_data = next(
        arg for arg in context.chromium_command if arg.startswith("--user-data-dir=")
    )
    assert user_data == f"--user-data-dir={expected}"


@then(
    "the chromium executor did not use the privileged banking browser profile directory"
)  # noqa: E501
def then_chromium_did_not_use_privileged_profile(context: object) -> None:
    live_root = context.chromium_live_root
    privileged = browser_profile_dir(live_root, "privileged:banking")
    user_data = next(
        arg for arg in context.chromium_command if arg.startswith("--user-data-dir=")
    )
    assert str(privileged) not in user_data
