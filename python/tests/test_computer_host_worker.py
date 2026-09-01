"""Kernel tests for the summoned-host computer pull worker."""

from __future__ import annotations

import json
from unittest.mock import patch

from chatticus.computer_continuation_driver import prepare_computer_continuation
from chatticus.computer_host_boot import ComputerHostBootDriver
from chatticus.computer_host_worker import run_host_worker_once
from chatticus.control_plane import ControlPlane
from chatticus.http.app import create_app
from chatticus.http.client import HttpTurnClient
from chatticus.http.paths import org_path
from chatticus.http.test_server import start_test_server
from chatticus.messaging.store import InMemoryMessagingStore
from chatticus.worker.computer import FakeComputerActionExecutor


class _FakeSqs:
    def __init__(self, body: str) -> None:
        self._body = body
        self.deleted: str | None = None

    def receive_message(self, **_kwargs: object) -> dict[str, object]:
        return {
            "Messages": [
                {"Body": self._body, "ReceiptHandle": "receipt-1"},
            ]
        }

    def delete_message(self, **kwargs: object) -> None:
        self.deleted = str(kwargs.get("ReceiptHandle"))


def test_host_worker_boots_then_runs_one_computer_job() -> None:
    plane = ControlPlane()
    api = start_test_server(create_app(plane))
    setup = prepare_computer_continuation(plane)
    job = setup.continuation_job
    body = json.dumps(
        {
            "job_id": job.job_id,
            "tenant_id": job.tenant_id,
            "turn_id": job.turn_id,
            "bot_id": job.bot_id,
            "user_id": job.user_id,
            "computer_id": job.computer_id,
            "computer_policy": job.computer_policy,
            "required_capabilities": sorted(job.required_capabilities),
        }
    )
    sqs = _FakeSqs(body)
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
            sqs_client=sqs,
            queue_url="https://sqs.example/computer",
            tenant_id=setup.tenant_id,
            user_id=setup.user_id,
            boot_driver=boot,
            action_executor=FakeComputerActionExecutor(),
        )
    assert ran is not None
    assert ran.job_id == job.job_id
    assert sqs.deleted == "receipt-1"
    record = plane.escalation_for(setup.tenant_id, setup.turn_id)
    assert record.result_committed is True
    api.close()


class _EmptySqs:
    def receive_message(self, **_kwargs: object) -> dict[str, object]:
        return {}

    def delete_message(self, **_kwargs: object) -> None:
        raise AssertionError("empty SQS should not delete")


def test_host_worker_runs_waiting_turn_when_sqs_is_empty() -> None:
    store = InMemoryMessagingStore()
    plane = ControlPlane(messaging_store=store)
    api = start_test_server(create_app(plane))
    bot = plane.create_bot("anthus", "ryan", "Researcher")
    channel = plane.create_channel("anthus", "ryan", [bot.bot_id])
    post = api.post(
        org_path(channel.tenant_id, f"/channels/{channel.channel_id}/messages"),
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
    plane.set_computer_stopped("anthus", "ryan", False)
    boot = ComputerHostBootDriver(plane, tenant_id=channel.tenant_id, user_id="ryan")
    with (
        patch.object(boot._xvfb, "start"),
        patch(
            "chatticus.computer_host_boot.verify_chromium_available",
            return_value="Chromium 120.0.0.0",
        ),
    ):
        ran = run_host_worker_once(
            plane=plane,
            turn_client=client,
            sqs_client=_EmptySqs(),
            queue_url="https://sqs.example/computer",
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
