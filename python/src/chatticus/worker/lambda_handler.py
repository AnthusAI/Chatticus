"""SQS-triggered computerless worker for cpu-only turns."""

from __future__ import annotations

import json
import logging
import os
from typing import Any

import httpx

from chatticus.http.app import INVOKE_HEADER
from chatticus.http.client import HttpTurnClient
from chatticus.runtime import job_from_queue_payload, plane_from_env
from chatticus.worker.computerless import ComputerlessWorker

logger = logging.getLogger("chatticus.worker")


def handler(event: dict[str, Any], _context: object) -> None:
    """Run one OpenAI text loop per SQS record and POST chunks to the front door."""
    plane = plane_from_env()
    base_url = os.environ["CHATTICUS_FRONT_DOOR_URL"].rstrip("/")
    invoke_key = os.environ.get("CHATTICUS_INVOKE_KEY", "")
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
        with httpx.Client(base_url=base_url, headers=headers, timeout=60.0) as client:
            ComputerlessWorker(plane, HttpTurnClient(client, job.tenant_id)).run_job(
                job
            )
        logger.info(
            "job_finished tenant_id=%s turn_id=%s attempt_id=%s",
            job.tenant_id,
            job.turn_id,
            job.job_id,
        )
