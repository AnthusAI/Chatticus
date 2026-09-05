"""Kernel tests for the SQS worker Lambda entrypoint."""

from __future__ import annotations

import json

import pytest

from chatticus.computer_continuation_driver import prepare_computer_continuation
from chatticus.control_plane import ControlPlane
from chatticus.host_starter import RecordingHostStarter
from chatticus.http.app import create_app
from chatticus.http.test_server import start_test_server
from chatticus.worker.lambda_handler import handler


def _sqs_event_for_job(job: object, *, message_id: str = "msg-1") -> dict[str, object]:
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
    return {
        "Records": [
            {
                "messageId": message_id,
                "receiptHandle": "receipt-1",
                "body": body,
            }
        ]
    }


def test_computer_worker_lambda_nacks_in_flight_without_host_executor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    plane = ControlPlane()
    api = start_test_server(create_app(plane))
    setup = prepare_computer_continuation(plane)
    starter = RecordingHostStarter()
    message_id = "computer-turn-job-1"
    monkeypatch.delenv("AWS_REGION", raising=False)
    monkeypatch.delenv("AWS_DEFAULT_REGION", raising=False)
    monkeypatch.setenv("CHATTICUS_WORKER_KIND", "computer")
    monkeypatch.setenv(
        "CHATTICUS_COMPUTER_TURN_QUEUE_URL", "https://sqs.example/computer"
    )
    monkeypatch.delenv("CHATTICUS_INVOKE_KEY", raising=False)
    monkeypatch.setattr(
        "chatticus.worker.lambda_handler.plane_from_env",
        lambda: plane,
    )
    monkeypatch.setattr(
        "chatticus.worker.lambda_handler._front_door_base_url",
        lambda: str(api.base_url),
    )
    monkeypatch.setattr(
        "chatticus.worker.lambda_handler.host_starter_from_env",
        lambda _get_organization=None: starter,
    )
    result = handler(
        _sqs_event_for_job(setup.continuation_job, message_id=message_id), None
    )
    assert result == {"batchItemFailures": [{"itemIdentifier": message_id}]}
    assert len(starter.invocations) == 1
    api.close()
