"""Prepare a fenced handoff with a queued computer continuation job."""

from __future__ import annotations

from dataclasses import dataclass

from chatticus.control_plane import ControlPlane
from chatticus.escalation_driver import EscalationHandoffDriver
from chatticus.models import TurnJob


@dataclass
class ComputerContinuationSetup:
    """One turn ready for a computer-capable pull worker."""

    tenant_id: str
    user_id: str
    turn_id: str
    continuation_job: TurnJob
    pending_action_id: str


def prepare_computer_continuation(
    plane: ControlPlane,
    *,
    tenant_id: str = "anthus",
    user_id: str = "ryan",
) -> ComputerContinuationSetup:
    """Commit tool.call, enqueue continuation, and relinquish the computerless fence."""
    driver = EscalationHandoffDriver(plane)
    driver.tenant_id = tenant_id
    driver.user_id = user_id
    driver.given_ready_to_request_computer_tool()
    assert driver.turn_id is not None
    record = plane.escalation_for(tenant_id, driver.turn_id)
    plane.record_model_request(tenant_id, driver.turn_id, "I will open household mail.")
    plane.commit_pending_computer_tool(tenant_id, driver.turn_id)
    plane.enqueue_computer_continuation(tenant_id, driver.turn_id)
    plane.relinquish_computerless_ownership(tenant_id, driver.turn_id)
    plane.set_computer_stopped(tenant_id, user_id, False)
    record = plane.escalation_for(tenant_id, driver.turn_id)
    assert record.continuation_job_id is not None
    job = next(job for job in plane._jobs if job.job_id == record.continuation_job_id)
    assert "computer" in job.required_capabilities
    return ComputerContinuationSetup(
        tenant_id=tenant_id,
        user_id=user_id,
        turn_id=driver.turn_id,
        continuation_job=job,
        pending_action_id=record.pending_call.action_id,
    )
