"""Kernel tests for computer host boot through browser readiness."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from chatticus.computer_capabilities import BROWSER_CAPABILITY
from chatticus.computer_host_boot import ComputerHostBootDriver, XvfbProcess
from chatticus.control_plane import ControlPlane


def test_computer_host_boot_records_browser_gate_after_chromium_probe() -> None:
    plane = ControlPlane()
    xvfb = MagicMock(spec=XvfbProcess)
    driver = ComputerHostBootDriver(plane, xvfb=xvfb)
    with patch(
        "chatticus.computer_host_boot.verify_chromium_available",
        return_value="Chromium 120.0.0.0",
    ):
        result = driver.boot_through_browser()
    xvfb.start.assert_called_once()
    readiness = plane.computer_capability_readiness(driver.tenant_id)
    assert readiness.is_ready("model") is True
    assert readiness.is_ready("workspace") is True
    assert readiness.is_ready(BROWSER_CAPABILITY) is True
    assert result.chromium_version == "Chromium 120.0.0.0"
    assert driver.readiness_order == ["model", "workspace", BROWSER_CAPABILITY]
    assert plane.computer_for_organization(driver.tenant_id).stopped is False


def test_computer_worker_commits_tool_result_with_chromium_executor() -> None:
    from chatticus.computer_continuation_driver import prepare_computer_continuation
    from chatticus.http.app import create_app
    from chatticus.http.client import HttpTurnClient
    from chatticus.http.test_server import start_test_server
    from chatticus.worker.computer import ComputerWorker

    plane = ControlPlane()
    api = start_test_server(create_app(plane))
    setup = prepare_computer_continuation(plane)
    executor = MagicMock()
    executor.execute.return_value = "opened:https://example.test"
    ComputerWorker(
        plane,
        HttpTurnClient(api, setup.tenant_id),
        action_executor=executor,
    ).run_job(setup.continuation_job)
    record = plane.escalation_for(setup.tenant_id, setup.turn_id)
    assert record.result_body == "opened:https://example.test"
    assert plane.unresolved_tool_action_ids(setup.tenant_id, setup.turn_id) == []
    api.close()


def test_xvfb_start_waits_for_display() -> None:
    xvfb = XvfbProcess(":42")
    with patch("chatticus.computer_host_boot.subprocess.Popen") as popen:
        process = MagicMock()
        process.poll.return_value = None
        popen.return_value = process
        with patch("chatticus.computer_host_boot.subprocess.run") as run:
            run.return_value.returncode = 0
            xvfb.start()
    assert popen.call_args.args[0][0] == "Xvfb"
