"""SQS-triggered computerless worker for cpu-only turns."""

from __future__ import annotations

import json
import logging
import os
from collections.abc import Callable
from typing import Any

import httpx

from chatticus.http.app import INVOKE_HEADER
from chatticus.http.client import HttpTurnClient
from chatticus.runtime import job_from_queue_payload, plane_from_env
from chatticus.worker.computerless import ComputerlessWorker

logger = logging.getLogger("chatticus.worker")

_DEFAULT_VISIBILITY_SECONDS = 180


def _sqs_visibility_renewer(
    sqs_client: Any,
    queue_url: str,
    receipt_handle: str,
    visibility_timeout: int,
) -> Callable[[], None]:
    def renew() -> None:
        sqs_client.change_message_visibility(
            QueueUrl=queue_url,
            ReceiptHandle=receipt_handle,
            VisibilityTimeout=visibility_timeout,
        )
        logger.info("sqs_visibility_renewed queue=%s", queue_url)

    return renew


def handler(event: dict[str, Any], _context: object) -> None:
    """Run one OpenAI text loop per SQS record and POST chunks to the front door."""
    plane = plane_from_env()
    base_url = os.environ["CHATTICUS_FRONT_DOOR_URL"].rstrip("/")
    invoke_key = os.environ.get("CHATTICUS_INVOKE_KEY", "")
    queue_url = os.environ.get("CHATTICUS_TURN_QUEUE_URL", "").strip()
    visibility_timeout = int(
        os.environ.get(
            "CHATTICUS_SQS_VISIBILITY_SECONDS",
            str(_DEFAULT_VISIBILITY_SECONDS),
        )
    )
    sqs_client = None
    if queue_url:
        import boto3

        sqs_client = boto3.client("sqs")
    for record in event.get("Records", []):
        payload = json.loads(record["body"])
        job = job_from_queue_payload(payload)
        logger.info(
            "job_started tenant_id=%s turn_id=%s attempt_id=%s",
            job.tenant_id,
            job.turn_id,
            job.job_id,
        )
        headers = {"X-Tenant-Id": job.tenant_id}
        if invoke_key:
            headers[INVOKE_HEADER] = invoke_key
        queue_visibility_renewer = None
        if sqs_client is not None and queue_url:
            queue_visibility_renewer = _sqs_visibility_renewer(
                sqs_client,
                queue_url,
                record["receiptHandle"],
                visibility_timeout,
            )
        with httpx.Client(base_url=base_url, headers=headers, timeout=60.0) as client:
            ComputerlessWorker(
                plane,
                HttpTurnClient(client, job.tenant_id),
                queue_visibility_renewer=queue_visibility_renewer,
            ).run_job(job)
        logger.info(
            "job_finished tenant_id=%s turn_id=%s attempt_id=%s",
            job.tenant_id,
            job.turn_id,
            job.job_id,
        )
