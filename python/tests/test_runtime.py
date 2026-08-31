"""Runtime wiring: cpu and computer jobs publish to separate SQS URLs."""

from __future__ import annotations

import json

import pytest

from chatticus.models import TurnJob
from chatticus.runtime import _sqs_enqueuer


def test_sqs_enqueuer_sends_cpu_and_computer_payloads(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sent: list[dict[str, str]] = []

    class FakeSqs:
        def send_message(self, **kwargs: str) -> None:
            sent.append(kwargs)

    monkeypatch.setattr("boto3.client", lambda *_args, **_kwargs: FakeSqs())
    cpu_enqueue = _sqs_enqueuer("https://sqs.example/cpu")
    computer_enqueue = _sqs_enqueuer("https://sqs.example/computer")
    cpu_enqueue(
        TurnJob(
            job_id="cpu-job",
            tenant_id="anthus",
            required_capabilities=frozenset({"cpu"}),
            turn_id="turn-1",
        )
    )
    computer_enqueue(
        TurnJob(
            job_id="computer-job",
            tenant_id="anthus",
            required_capabilities=frozenset({"computer"}),
            turn_id="turn-1",
        )
    )
    assert [item["QueueUrl"] for item in sent] == [
        "https://sqs.example/cpu",
        "https://sqs.example/computer",
    ]
    assert json.loads(sent[0]["MessageBody"])["job_id"] == "cpu-job"
    assert json.loads(sent[1]["MessageBody"])["required_capabilities"] == ["computer"]
