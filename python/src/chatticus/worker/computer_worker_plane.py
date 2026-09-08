"""Protocol for computer host boot, job discovery, and ComputerWorker."""

from __future__ import annotations

from typing import Protocol

from chatticus.capability_policy import CapabilityPolicy, PolicyBrowserContext
from chatticus.computer_capabilities import ComputerCapabilityReadiness
from chatticus.computer_start import HostStartClaim
from chatticus.escalation_handoff import EscalationRecord
from chatticus.models import Computer, Turn, TurnEvent


class ComputerWorkerPlane(Protocol):
    """Control-plane operations used by host boot, job discovery, and ComputerWorker."""

    def set_computer_stopped(self, tenant_id: str, stopped: bool) -> None:
        """Mark the organization computer stopped or running."""

    def record_computer_capability_ready(
        self,
        tenant_id: str,
        user_id: str,
        capability: str,
    ) -> None:
        """Record that one capability gate cleared on the computer host."""

    def computer_for_organization(self, tenant_id: str) -> Computer:
        """Return the organization computer."""

    def list_active_turns(self, tenant_id: str, user_id: str) -> list[Turn]:
        """List active turns for one household member."""

    def turn(self, tenant_id: str, turn_id: str) -> Turn:
        """Return one turn."""

    def remove_pending_job(self, job_id: str) -> None:
        """Drop one in-process pending job when present."""

    def expire_orphaned_computer_claims(self) -> None:
        """Release expired exclusive computer leases."""

    def ensure_computer_escalation(
        self,
        tenant_id: str,
        turn_id: str,
    ) -> EscalationRecord | None:
        """Rebuild computer handoff state from the durable turn and journal."""

    def unresolved_tool_action_ids(
        self,
        tenant_id: str,
        turn_id: str,
    ) -> list[str]:
        """Return unresolved tool.call action ids for one turn."""

    def request_computer_host_start(
        self,
        tenant_id: str,
        turn_id: str,
        *,
        user_id: str,
    ) -> HostStartClaim:
        """Record one host-start generation for a waiting turn."""

    def mark_host_start_dispatched(
        self,
        tenant_id: str,
        host_start_generation: int,
    ) -> bool:
        """Mark the current host-start generation dispatched."""

    def release_host_start_dispatch(
        self,
        tenant_id: str,
        host_start_generation: int,
    ) -> None:
        """Release a host-start dispatch marker after a failed start."""

    def computer_capability_readiness(
        self,
        tenant_id: str,
    ) -> ComputerCapabilityReadiness:
        """Return per-capability readiness for one household computer."""

    def record_attempt_claimed(self, tenant_id: str, turn_id: str) -> TurnEvent:
        """Record that the current fenced owner claimed this turn."""

    def claim_computer_for_turn(
        self,
        tenant_id: str,
        turn_id: str,
        worker_id: str,
    ) -> bool:
        """Take an exclusive computer lease for the fenced turn owner."""

    def commit_computer_tool_result(
        self,
        tenant_id: str,
        turn_id: str,
        result_body: str,
    ) -> None:
        """Commit one computer tool.result for the pending action."""

    def execute_pending_computer_action(
        self,
        tenant_id: str,
        turn_id: str,
    ) -> None:
        """Execute the pending computer action on the host."""

    def complete_computer_continuation(
        self,
        tenant_id: str,
        turn_id: str,
    ) -> None:
        """Finish the computer continuation and resume the turn."""

    def active_browser_context(
        self,
        tenant_id: str,
        turn_id: str,
    ) -> PolicyBrowserContext | None:
        """Return the active browser storage partition for one turn."""

    def capability_policy_for(
        self,
        tenant_id: str,
        turn_id: str,
    ) -> CapabilityPolicy:
        """Return the capability policy bound to one turn."""

    def gated_browse_origin(
        self,
        tenant_id: str,
        turn_id: str,
        url: str,
    ) -> None:
        """Authorize one browse origin for a gated browser tool."""

    def record_computer_hydrated(
        self,
        tenant_id: str,
        worker_id: str,
    ) -> None:
        """Clear relocate flags after the host finished hydrating."""

    def publish_computer_snapshot(
        self,
        tenant_id: str,
        worker_id: str,
        checksum: str,
    ) -> None:
        """Persist snapshot metadata after the host uploaded a pack."""
