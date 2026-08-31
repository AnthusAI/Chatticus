"""Computer-capable worker: journal continuation for unresolved tool calls."""

from __future__ import annotations

from collections.abc import Callable
from typing import Protocol

from chatticus.computer_capabilities import (
    capability_for_computer_tool,
)
from chatticus.control_plane import ControlPlane
from chatticus.host_starter import HostStarter, NoOpHostStarter
from chatticus.http.client import HttpTurnClient
from chatticus.models import (
    ComputerWorkerHostNotReady,
    ComputerWorkerRequiresComputerCapability,
    TurnJob,
    TurnStatus,
    pending_computer_tool_from_turn,
)


class ComputerActionExecutor(Protocol):
    """Run one committed computer tool call and return its result body."""

    def execute(self, tool_name: str, arguments: dict[str, str]) -> str:
        """Return the durable tool.result body for one action."""


class FakeComputerActionExecutor:
    """Deterministic stand-in so kernel tests never touch a live browser."""

    def execute(self, tool_name: str, arguments: dict[str, str]) -> str:
        """Return a short result derived from the tool name."""
        if tool_name == "browser_open":
            return "opened"
        return f"{tool_name}-done"


class ComputerWorker:
    """Pull computer continuation jobs and finish unresolved journal tool calls."""

    def __init__(
        self,
        plane: ControlPlane,
        turn_client: HttpTurnClient,
        *,
        action_executor: ComputerActionExecutor | None = None,
        host_starter: HostStarter | None = None,
        queue_visibility_renewer: Callable[[], None] | None = None,
    ) -> None:
        self.plane = plane
        self.turn_client = turn_client
        self._queue_visibility_renewer = queue_visibility_renewer
        self.action_executor = action_executor
        self.host_starter = host_starter or NoOpHostStarter()

    def _dispatch_host_start_if_needed(
        self,
        tenant_id: str,
        user_id: str,
        turn_id: str,
    ) -> None:
        """Invoke the host-start driver once per durable generation."""
        claim = self.plane.request_computer_host_start(tenant_id, user_id, turn_id)
        computer = self.plane.computer_for_user(tenant_id, user_id)
        if computer.host_start_dispatched_generation >= computer.host_start_generation:
            return
        try:
            self.host_starter.start_host(claim)
        except Exception as exc:
            raise ComputerWorkerHostNotReady(
                f"Turn {turn_id!r} host start failed: {exc}."
            ) from exc
        self.plane.mark_host_start_dispatched(
            tenant_id, user_id, computer.host_start_generation
        )

    def _host_ready_for_tool(self, job: TurnJob, tool_name: str) -> bool:
        """Return whether a real computer host can run one pending tool call."""
        if self.action_executor is None:
            return False
        if job.user_id is None:
            return False
        computer = self.plane.computer_for_user(job.tenant_id, job.user_id)
        if computer.stopped:
            return False
        capability = capability_for_computer_tool(tool_name)
        return self.plane.computer_capability_readiness(
            job.tenant_id, job.user_id
        ).is_ready(capability)

    def complete_pending_for_bot(self, bot_id: str) -> None:
        """Run every queued computer continuation job for one bot."""
        jobs = [
            job
            for job in self.plane.pending_jobs_for_bot(bot_id)
            if "computer" in job.required_capabilities
        ]
        for job in jobs:
            self.run_job(job)

    def run_job(self, job: TurnJob) -> None:
        """Claim the turn, execute unresolved tool.call ids, commit tool.result.

        Jobs without the ``computer`` capability are refused without ack.
        When no real host can run the pending tool, ``ComputerWorkerHostNotReady``
        is raised so SQS does not delete the message. The worker does not
        claim the turn fence in that case.
        """
        if "computer" not in job.required_capabilities:
            msg = (
                f"Computer worker cannot execute job {job.job_id!r} "
                f"without computer capability."
            )
            raise ComputerWorkerRequiresComputerCapability(msg)
        if job.turn_id is None:
            return
        turn = self.plane.turn(job.tenant_id, job.turn_id)
        if turn.status != TurnStatus.ACTIVE:
            self.plane.remove_pending_job(job.job_id)
            return
        self.plane.expire_orphaned_computer_claims()
        try:
            record = self.plane.escalation_for(job.tenant_id, job.turn_id)
        except Exception:
            record = None
        unresolved = self.plane.unresolved_tool_action_ids(job.tenant_id, job.turn_id)
        if record is None:
            pending = pending_computer_tool_from_turn(turn)
            if not unresolved and pending is None:
                return
            tool_name = pending.tool_name if pending is not None else "computer"
            if job.user_id is not None:
                self._dispatch_host_start_if_needed(
                    job.tenant_id, job.user_id, job.turn_id
                )
            raise ComputerWorkerHostNotReady(
                f"Turn {job.turn_id!r} has no ready computer host for {tool_name!r}."
            )
        if not unresolved and record.result_committed:
            self.plane.remove_pending_job(job.job_id)
            return
        tool_name = record.pending_call.tool_name
        if unresolved and not self._host_ready_for_tool(job, tool_name):
            if job.user_id is not None:
                self._dispatch_host_start_if_needed(
                    job.tenant_id, job.user_id, job.turn_id
                )
            raise ComputerWorkerHostNotReady(
                f"Turn {job.turn_id!r} has no ready computer host for {tool_name!r}."
            )
        worker_id = job.job_id
        claimed = self.turn_client.claim(job.turn_id, worker_id)
        turn = self.plane.turn(job.tenant_id, job.turn_id)
        if not claimed.get("acquired") and turn.claimed_by_worker_id != worker_id:
            return
        if claimed.get("acquired"):
            self.plane.record_attempt_claimed(job.tenant_id, job.turn_id)
        if not self.plane.claim_computer_for_turn(
            job.tenant_id, job.turn_id, worker_id
        ):
            return
        if unresolved:
            self.plane.execute_pending_computer_action(job.tenant_id, job.turn_id)
        if not record.result_committed:
            if record.computer_action_count == 0:
                return
            if self.action_executor is None:
                return
            result_body = self.action_executor.execute(
                record.pending_call.tool_name,
                dict(record.pending_call.arguments),
            )
            self.plane.commit_computer_tool_result(
                job.tenant_id, job.turn_id, result_body
            )
        if self.plane.unresolved_tool_action_ids(job.tenant_id, job.turn_id):
            return
        self.plane.remove_pending_job(job.job_id)
