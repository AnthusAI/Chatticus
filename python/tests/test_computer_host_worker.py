"""Kernel tests for the summoned-host computer pull worker."""

from __future__ import annotations

from unittest.mock import patch

from http_test_support import start_authed_test_server

from chatticus.computer_continuation_driver import prepare_computer_continuation
from chatticus.computer_host_boot import ComputerHostBootDriver
from chatticus.computer_host_worker import discover_computer_job, run_host_worker_once
from chatticus.control_plane import ControlPlane
from chatticus.http.client import HttpTurnClient
from chatticus.http.worker_plane_client import HttpWorkerPlane
from chatticus.messaging.store import InMemoryMessagingStore
from chatticus.worker.computer import FakeComputerActionExecutor


def _client_for(plane: ControlPlane):
    return start_authed_test_server(plane, invoke_key="")


def test_host_worker_boots_then_runs_one_computer_job() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    setup = prepare_computer_continuation(plane)
    boot = ComputerHostBootDriver(
        plane, tenant_id=setup.tenant_id, user_id=setup.user_id
    )
    with (
        patch.object(boot._xvfb, "start"),
        patch(
            "chatticus.computer_host_boot.verify_chromium_available",
            return_value="Chromium 120.0.0.0",
        ),
    ):
        ran = run_host_worker_once(
            plane=plane,
            turn_client=HttpTurnClient(api, setup.tenant_id),
            tenant_id=setup.tenant_id,
            user_id=setup.user_id,
            boot_driver=boot,
            action_executor=FakeComputerActionExecutor(),
        )
    assert ran is not None
    assert ran.turn_id == setup.turn_id
    record = plane.escalation_for(setup.tenant_id, setup.turn_id)
    assert record.result_committed is True
    api.close()


def test_host_worker_discovers_continuation_without_sqs() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    setup = prepare_computer_continuation(plane)
    worker_plane = HttpWorkerPlane(api, setup.tenant_id, setup.user_id, invoke_key="")
    discovered = discover_computer_job(worker_plane, setup.tenant_id, setup.user_id)
    assert discovered is not None
    assert discovered.turn_id == setup.turn_id
    api.close()


def test_host_worker_runs_waiting_turn_via_http_plane() -> None:
    store = InMemoryMessagingStore()
    plane = ControlPlane(messaging_store=store)
    api = _client_for(plane)
    bot = plane.create_bot("anthus", "Researcher", creator_user_id="ryan")
    channel = plane.create_channel("anthus", "ryan", [bot.bot_id])
    post = api.post(
        f"/orgs/{channel.tenant_id}/channels/{channel.channel_id}/messages",
        json={
            "author_kind": "human",
            "author_id": "ryan",
            "body": "open the household browser",
            "addressed_to_bot_id": bot.bot_id,
        },
    )
    turn_id = post.json()["turn_id"]
    client = HttpTurnClient(api, channel.tenant_id)
    client.claim(turn_id, "waiting-worker")
    client.post_waiting(turn_id, "browser")
    plane.set_computer_stopped("anthus", False)
    worker_plane = HttpWorkerPlane(api, channel.tenant_id, "ryan", invoke_key="")
    boot = ComputerHostBootDriver(
        worker_plane, tenant_id=channel.tenant_id, user_id="ryan"
    )
    with (
        patch.object(boot._xvfb, "start"),
        patch(
            "chatticus.computer_host_boot.verify_chromium_available",
            return_value="Chromium 120.0.0.0",
        ),
    ):
        ran = run_host_worker_once(
            plane=worker_plane,
            turn_client=client,
            tenant_id=channel.tenant_id,
            user_id="ryan",
            boot_driver=boot,
            action_executor=FakeComputerActionExecutor(),
        )
    assert ran is not None
    assert ran.turn_id == turn_id
    record = plane.escalation_for(channel.tenant_id, turn_id)
    assert record.result_committed is True
    api.close()
