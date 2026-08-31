"""Pull computer continuation jobs on the summoned household host."""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any

from chatticus.chromium_action_executor import ChromiumActionExecutor
from chatticus.computer_host_boot import ComputerHostBootDriver
from chatticus.control_plane import ControlPlane
from chatticus.http.client import HttpTurnClient
from chatticus.models import TurnJob
from chatticus.runtime import job_from_queue_payload
from chatticus.worker.computer import ComputerActionExecutor, ComputerWorker

logger = logging.getLogger("chatticus.computer_host_worker")


def waiting_computer_job(
    plane: ControlPlane, tenant_id: str, user_id: str
) -> TurnJob | None:
    """Rebuild one computer job from a durable waiting turn for this user."""
    computer = plane.computer_for_user(tenant_id, user_id)
    for turn in plane.list_active_turns(tenant_id, user_id):
        if not turn.waiting_for:
            continue
        return TurnJob(
            job_id=f"host-{computer.computer_id}-{turn.turn_id}",
            tenant_id=tenant_id,
            required_capabilities=frozenset({"cpu", "computer"}),
            computer_id=computer.computer_id,
            user_id=user_id,
            bot_id=turn.bot_id,
            turn_id=turn.turn_id,
        )
    return None


def run_host_worker_once(
    *,
    plane: ControlPlane,
    turn_client: HttpTurnClient,
    sqs_client: Any,
    queue_url: str,
    tenant_id: str,
    user_id: str,
    boot_driver: ComputerHostBootDriver | None = None,
    action_executor: ComputerActionExecutor | None = None,
) -> TurnJob | None:
    """Boot capability gates, receive at most one computer job, and run it."""
    driver = boot_driver or ComputerHostBootDriver(
        plane, tenant_id=tenant_id, user_id=user_id
    )
    driver.boot_through_browser()
    response = sqs_client.receive_message(
        QueueUrl=queue_url,
        MaxNumberOfMessages=1,
        WaitTimeSeconds=1,
        VisibilityTimeout=180,
    )
    messages = response.get("Messages") or []
    receipt = None
    if messages:
        message = messages[0]
        body = message.get("Body") or message.get("body")
        job = job_from_queue_payload(json.loads(body))
        receipt = message.get("ReceiptHandle") or message.get("receiptHandle")
    else:
        job = waiting_computer_job(plane, tenant_id, user_id)
    if job is None:
        return None
    ComputerWorker(
        plane,
        turn_client,
        action_executor=action_executor or ChromiumActionExecutor(),
    ).run_job(job)
    if receipt:
        sqs_client.delete_message(QueueUrl=queue_url, ReceiptHandle=receipt)
    return job


def main() -> None:
    """Entry point for the Fargate computer container override."""
    from chatticus.runtime import plane_from_env

    tenant_id = os.environ.get("CHATTICUS_TENANT_ID", "").strip()
    user_id = os.environ.get("CHATTICUS_USER_ID", "").strip()
    queue_url = os.environ.get("CHATTICUS_COMPUTER_TURN_QUEUE_URL", "").strip()
    if not (tenant_id and user_id and queue_url):
        raise KeyError("CHATTICUS_TENANT_ID, CHATTICUS_USER_ID, queue URL")
    plane = plane_from_env()
    logger.info(
        "computer_host_worker_start tenant_id=%s user_id=%s", tenant_id, user_id
    )
    import boto3
    import httpx

    from chatticus.http.app import INVOKE_HEADER
    from chatticus.worker.lambda_handler import _front_door_base_url

    region = (
        os.environ.get("AWS_REGION")
        or os.environ.get("AWS_DEFAULT_REGION")
        or "us-east-1"
    )
    sqs_client = boto3.client("sqs", region_name=region)
    headers = {}
    invoke_key = os.environ.get("CHATTICUS_INVOKE_KEY", "").strip()
    if invoke_key:
        headers[INVOKE_HEADER] = invoke_key
    deadline = time.monotonic() + int(
        os.environ.get("CHATTICUS_HOST_WORKER_SECONDS", "120")
    )
    with httpx.Client(
        base_url=_front_door_base_url(), headers=headers, timeout=60.0
    ) as client:
        turn_client = HttpTurnClient(client, tenant_id)
        while time.monotonic() < deadline:
            ran = run_host_worker_once(
                plane=plane,
                turn_client=turn_client,
                sqs_client=sqs_client,
                queue_url=queue_url,
                tenant_id=tenant_id,
                user_id=user_id,
            )
            if ran is not None:
                return
            time.sleep(1)


if __name__ == "__main__":
    main()
