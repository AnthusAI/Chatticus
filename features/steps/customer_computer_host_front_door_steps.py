"""Behave steps for the customer computer host Front Door worker plane."""

from __future__ import annotations

from unittest.mock import patch

from behave import then, when

from chatticus.computer_capabilities import BROWSER_CAPABILITY, MODEL_CAPABILITY
from chatticus.computer_host_boot import ComputerHostBootDriver
from chatticus.computer_host_worker import discover_computer_job, run_host_worker_once
from chatticus.http.client import HttpTurnClient
from chatticus.http.worker_plane_client import HttpWorkerPlane
from chatticus.worker.computer import FakeComputerActionExecutor


def _worker_plane(context: object) -> HttpWorkerPlane:
    return HttpWorkerPlane(
        context.api_client,
        "anthus",
        "ryan",
        invoke_key="",
    )


@when("the customer computer host boots through the Front Door worker plane")
def when_customer_host_boots_through_front_door(context: object) -> None:
    driver = ComputerHostBootDriver(
        _worker_plane(context), tenant_id="anthus", user_id="ryan"
    )
    with (
        patch.object(driver._xvfb, "start"),
        patch(
            "chatticus.computer_host_boot.verify_chromium_available",
            return_value="Chromium 120.0.0.0",
        ),
    ):
        context.host_boot = driver.boot_through_browser()


@then("tenant {tenant_id} household computer readiness reports model before browser")
def then_readiness_model_before_browser(context: object, tenant_id: str) -> None:
    del tenant_id
    order = context.host_boot.readiness_order
    assert order.index(MODEL_CAPABILITY) < order.index(BROWSER_CAPABILITY)
    readiness = _worker_plane(context).computer_capability_readiness("anthus")
    assert readiness.is_ready(MODEL_CAPABILITY) is True


@then("tenant {tenant_id} household computer readiness reports browser ready")
def then_readiness_browser_ready(context: object, tenant_id: str) -> None:
    del tenant_id
    readiness = _worker_plane(context).computer_capability_readiness("anthus")
    assert readiness.is_ready(BROWSER_CAPABILITY) is True


@when("the customer computer host discovers a computer job through the Front Door")
def when_customer_host_discovers_job(context: object) -> None:
    context.discovered_job = discover_computer_job(
        _worker_plane(context), "anthus", "ryan"
    )


@then("the discovered computer job matches the queued continuation job")
def then_discovered_job_matches_continuation(context: object) -> None:
    setup = context.computer_continuation
    discovered = context.discovered_job
    assert discovered is not None
    assert discovered.turn_id == setup.turn_id
    assert discovered.bot_id == setup.continuation_job.bot_id
    assert discovered.user_id == setup.continuation_job.user_id


@when("the customer computer host runs one browser_open job through the Front Door")
def when_customer_host_runs_browser_open(context: object) -> None:
    setup = context.computer_continuation
    plane = _worker_plane(context)
    driver = ComputerHostBootDriver(
        plane, tenant_id=setup.tenant_id, user_id=setup.user_id
    )
    with (
        patch.object(driver._xvfb, "start"),
        patch(
            "chatticus.computer_host_boot.verify_chromium_available",
            return_value="Chromium 120.0.0.0",
        ),
    ):
        context.ran_job = run_host_worker_once(
            plane=plane,
            turn_client=HttpTurnClient(context.api_client, setup.tenant_id),
            tenant_id=setup.tenant_id,
            user_id=setup.user_id,
            boot_driver=driver,
            action_executor=FakeComputerActionExecutor(),
        )
    assert context.ran_job is not None
