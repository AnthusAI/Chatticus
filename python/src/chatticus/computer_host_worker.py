"""Pull computer continuation jobs on the summoned household host."""

from __future__ import annotations

import logging
import os
import time

from chatticus.chromium_action_executor import ChromiumActionExecutor
from chatticus.computer_host_boot import ComputerHostBootDriver
from chatticus.host_starter import NoOpHostStarter
from chatticus.http.client import HttpTurnClient
from chatticus.models import TurnJob, TurnStatus
from chatticus.worker.computer import ComputerActionExecutor, ComputerWorker
from chatticus.worker.computer_worker_plane import ComputerWorkerPlane

logger = logging.getLogger("chatticus.computer_host_worker")


def discover_computer_job(
    plane: ComputerWorkerPlane, tenant_id: str, user_id: str
) -> TurnJob | None:
    """Rebuild one computer job from active turns for this household member."""
    computer = plane.computer_for_organization(tenant_id)
    for turn in plane.list_active_turns(tenant_id, user_id):
        if turn.status != TurnStatus.ACTIVE:
            continue
        record = plane.ensure_computer_escalation(tenant_id, turn.turn_id)
        if record is not None and not record.result_committed:
            job_user = record.user_id or user_id
            return TurnJob(
                job_id=f"host-{computer.computer_id}-{turn.turn_id}",
                tenant_id=tenant_id,
                required_capabilities=frozenset({"cpu", "computer"}),
                computer_id=computer.computer_id,
                user_id=job_user,
                bot_id=turn.bot_id,
                turn_id=turn.turn_id,
            )
        if turn.waiting_for:
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
    plane: ComputerWorkerPlane,
    turn_client: HttpTurnClient,
    tenant_id: str,
    user_id: str,
    boot_driver: ComputerHostBootDriver | None = None,
    action_executor: ComputerActionExecutor | None = None,
) -> TurnJob | None:
    """Boot capability gates, discover one computer job, and run it."""
    driver = boot_driver or ComputerHostBootDriver(
        plane, tenant_id=tenant_id, user_id=user_id
    )
    driver.boot_through_browser()
    job = discover_computer_job(plane, tenant_id, user_id)
    if job is None:
        return None
    ComputerWorker(
        plane,
        turn_client,
        action_executor=action_executor or ChromiumActionExecutor(),
        host_starter=NoOpHostStarter(),
    ).run_job(job)
    return job


def main() -> None:
    """Entry point for the Fargate computer container override."""
    tenant_id = os.environ.get("CHATTICUS_TENANT_ID", "").strip()
    user_id = os.environ.get("CHATTICUS_USER_ID", "").strip()
    if not (tenant_id and user_id):
        raise KeyError("CHATTICUS_TENANT_ID and CHATTICUS_USER_ID are required")
    logger.info(
        "computer_host_worker_start tenant_id=%s user_id=%s", tenant_id, user_id
    )
    import httpx

    from chatticus.http.app import INVOKE_HEADER
    from chatticus.http.worker_plane_client import HttpWorkerPlane
    from chatticus.worker.lambda_handler import _front_door_base_url

    invoke_key = os.environ.get("CHATTICUS_INVOKE_KEY", "").strip()
    headers = {}
    if invoke_key:
        headers[INVOKE_HEADER] = invoke_key
    deadline = time.monotonic() + int(
        os.environ.get("CHATTICUS_HOST_WORKER_SECONDS", "120")
    )
    with httpx.Client(
        base_url=_front_door_base_url(), headers=headers, timeout=60.0
    ) as client:
        plane = HttpWorkerPlane(
            client,
            tenant_id,
            user_id,
            invoke_key=invoke_key,
        )
        turn_client = HttpTurnClient(client, tenant_id)
        while time.monotonic() < deadline:
            ran = run_host_worker_once(
                plane=plane,
                turn_client=turn_client,
                tenant_id=tenant_id,
                user_id=user_id,
            )
            if ran is not None:
                return
            time.sleep(1)


if __name__ == "__main__":
    main()
