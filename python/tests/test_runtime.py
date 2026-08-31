"""Runtime wiring: cpu SQS must not carry computer continuation jobs."""

from __future__ import annotations

import json

import pytest

from chatticus.models import TurnJob
from chatticus.runtime import _sqs_enqueuer


def test_sqs_enqueuer_skips_computer_jobs(monkeypatch: pytest.MonkeyPatch) -> None:
    sent: list[dict[str, str]] = []

    class FakeSqs:
        def send_message(self, **kwargs: str) -> None:
            sent.append(kwargs)

    monkeypatch.setattr("boto3.client", lambda *_args, **_kwargs: FakeSqs())
    enqueue = _sqs_enqueuer("https://sqs.example/cpu")
    enqueue(
        TurnJob(
            job_id="cpu-job",
            tenant_id="anthus",
            required_capabilities=frozenset({"cpu"}),
            turn_id="turn-1",
        )
    )
    enqueue(
        TurnJob(
            job_id="computer-job",
            tenant_id="anthus",
            required_capabilities=frozenset({"computer"}),
            turn_id="turn-1",
        )
    )
    assert len(sent) == 1
    body = json.loads(sent[0]["MessageBody"])
    assert body["job_id"] == "cpu-job"
    assert body["required_capabilities"] == ["cpu"]
