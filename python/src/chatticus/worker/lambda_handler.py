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
from chatticus.models import ComputerWorkerHostNotReady
from chatticus.runtime import job_from_queue_payload, plane_from_env
from chatticus.worker.computer import ComputerWorker
from chatticus.worker.computerless import ComputerlessWorker

logger = logging.getLogger("chatticus.worker")
logging.getLogger().setLevel(logging.INFO)

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


def handler(event: dict[str, Any], _context: object) -> dict[str, Any] | None:
    """Run one SQS record: computerless text loop or computer-queue host gate."""
    plane = plane_from_env()
    base_url = _front_door_base_url()
    invoke_key = os.environ.get("CHATTICUS_INVOKE_KEY", "")
    worker_kind = os.environ.get("CHATTICUS_WORKER_KIND", "computerless").strip()
    batch_failures: list[dict[str, str]] = []
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

        region = (
            os.environ.get("AWS_REGION")
            or os.environ.get("AWS_DEFAULT_REGION")
            or "us-east-1"
        )
        sqs_client = boto3.client("sqs", region_name=region)
    for record in event.get("Records", []):
        payload = json.loads(record["body"])
        job = job_from_queue_payload(payload)
        logger.info(
            "job_started tenant_id=%s turn_id=%s attempt_id=%s",
            job.tenant_id,
            job.turn_id,
            job.job_id,
        )
        headers: dict[str, str] = {}
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
        try:
            with httpx.Client(
                base_url=base_url, headers=headers, timeout=60.0
            ) as client:
                worker_token = os.environ.get("CHATTICUS_WORKER_TOKEN", "").strip()
                worker_id = os.environ.get(
                    "CHATTICUS_WORKER_ID", "lambda-worker"
                ).strip()
                turn_client = HttpTurnClient(
                    client,
                    job.tenant_id,
                    worker_token=worker_token or None,
                    worker_id=worker_id,
                )
                if worker_kind == "computer":
                    ComputerWorker(
                        plane,
                        turn_client,
                        host_starter=host_starter_from_env(
                            plane.get_organization,
                        ),
                        queue_visibility_renewer=queue_visibility_renewer,
                    ).run_job(job)
                else:
                    ComputerlessWorker(
                        plane,
                        turn_client,
                        queue_visibility_renewer=queue_visibility_renewer,
                    ).run_job(job)
        except ComputerWorkerHostNotReady:
            if worker_kind != "computer":
                raise
            batch_failures.append({"itemIdentifier": record["messageId"]})
            logger.info(
                "job_nacked tenant_id=%s turn_id=%s attempt_id=%s message_id=%s",
                job.tenant_id,
                job.turn_id,
                job.job_id,
                record["messageId"],
            )
            continue
        logger.info(
            "job_finished tenant_id=%s turn_id=%s attempt_id=%s",
            job.tenant_id,
            job.turn_id,
            job.job_id,
        )
    if worker_kind == "computer":
        return {"batchItemFailures": batch_failures}
    return None
