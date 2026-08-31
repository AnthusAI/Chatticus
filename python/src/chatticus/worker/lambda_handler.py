"""SQS-triggered computerless worker for cpu-only turns."""

from __future__ import annotations

import json
import logging
import os
from collections.abc import Callable
from typing import Any

import httpx

from chatticus.host_starter import host_starter_from_env
from chatticus.http.app import INVOKE_HEADER
from chatticus.http.client import HttpTurnClient
from chatticus.runtime import job_from_queue_payload, plane_from_env
from chatticus.worker.computer import ComputerWorker
from chatticus.worker.computerless import ComputerlessWorker

logger = logging.getLogger("chatticus.worker")

_DEFAULT_VISIBILITY_SECONDS = 180


def _front_door_base_url() -> str:
    direct = os.environ.get("CHATTICUS_FRONT_DOOR_URL", "").strip()
    if direct:
        return direct.rstrip("/")
    environment = os.environ.get("CHATTICUS_ENVIRONMENT", "").strip()
    if not environment:
        raise KeyError("CHATTICUS_FRONT_DOOR_URL or CHATTICUS_ENVIRONMENT")
    from chatticus.cloud_environments import (
        parse_cloud_environment,
        resolve_thin_turn_base_url,
    )

    return resolve_thin_turn_base_url(parse_cloud_environment(environment))


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
    """Run one SQS record: computerless text loop or computer-queue host gate."""
    plane = plane_from_env()
    base_url = _front_door_base_url()
    invoke_key = os.environ.get("CHATTICUS_INVOKE_KEY", "")
    worker_kind = os.environ.get("CHATTICUS_WORKER_KIND", "computerless").strip()
    queue_url = os.environ.get(
        (
            "CHATTICUS_COMPUTER_TURN_QUEUE_URL"
            if worker_kind == "computer"
            else "CHATTICUS_TURN_QUEUE_URL"
        ),
        "",
    ).strip()
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
            turn_client = HttpTurnClient(client, job.tenant_id)
            if worker_kind == "computer":
                ComputerWorker(
                    plane,
                    turn_client,
                    host_starter=host_starter_from_env(),
                    queue_visibility_renewer=queue_visibility_renewer,
                ).run_job(job)
            else:
                ComputerlessWorker(
                    plane,
                    turn_client,
                    queue_visibility_renewer=queue_visibility_renewer,
                ).run_job(job)
        logger.info(
            "job_finished tenant_id=%s turn_id=%s attempt_id=%s",
            job.tenant_id,
            job.turn_id,
            job.job_id,
        )
