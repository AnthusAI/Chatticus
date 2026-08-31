"""Drive fenced computer handoff from durable typed journal events."""

from __future__ import annotations

from dataclasses import dataclass

from chatticus.escalation_driver import EscalationFaultOutcome, EscalationHandoffDriver
from chatticus.escalation_handoff import EscalationBoundary, EscalationCrash
from chatticus.models import TurnEventKind, TurnStatus


@dataclass
class StructuredHandoffOutcome(EscalationFaultOutcome):
    """Observed journal and computer state after structured recovery."""

    journal_kinds: list[str]
    unresolved_action_ids: list[str]
    computer_reclaimed: bool
    executed_action_id: str | None
    continuation_attempt_id: str | None


class StructuredHandoffDriver(EscalationHandoffDriver):
    """Computerless model request, fenced relinquish, journal-only continuation."""

    def crash_at(self, boundary: EscalationBoundary) -> None:
        """Walk the typed-event handoff until ``boundary``, then stop."""
        assert self.turn_id is not None
        turn_id = self.turn_id
        self.plane.record_model_request(self.tenant_id, turn_id, "open household mail")
        if boundary is EscalationBoundary.BEFORE_TOOL_CALL_COMMITTED:
            raise EscalationCrash(boundary)
        self.plane.commit_pending_computer_tool(self.tenant_id, turn_id)
        if boundary is EscalationBoundary.AFTER_COMMIT_BEFORE_ENQUEUE:
            raise EscalationCrash(boundary)
        self.plane.enqueue_computer_continuation(self.tenant_id, turn_id)
        if boundary is EscalationBoundary.AFTER_ENQUEUE_BEFORE_RELINQUISH:
            raise EscalationCrash(boundary)
        self.plane.relinquish_computerless_ownership(self.tenant_id, turn_id)
        claimed = self.plane.claim_turn_attempt(
            self.tenant_id, turn_id, "computer-worker"
        )
        assert claimed is not None and claimed.acquired
        self.plane.record_attempt_claimed(self.tenant_id, turn_id)
        self.plane.claim_computer_for_turn(self.tenant_id, turn_id, "computer-worker")
        self.plane.execute_pending_computer_action(self.tenant_id, turn_id)
        if boundary is EscalationBoundary.AFTER_ACTION_BEFORE_RESULT:
            raise EscalationCrash(boundary)
        if boundary is EscalationBoundary.AFTER_COMPUTER_LEASE_EXPIRED:
            self.plane.advance_seconds(self.plane.attempt_lease.total_seconds() + 1)
            self.plane.expire_orphaned_computer_claims()
            raise EscalationCrash(boundary)
        self.plane.commit_computer_tool_result(self.tenant_id, turn_id, "opened")

    def finish_happy_path(self) -> StructuredHandoffOutcome:
        """Commit, relinquish, claim, and finish the unresolved tool call."""
        assert self.turn_id is not None
        self.plane.record_model_request(
            self.tenant_id, self.turn_id, "open household mail"
        )
        self.plane.commit_pending_computer_tool(self.tenant_id, self.turn_id)
        self.plane.enqueue_computer_continuation(self.tenant_id, self.turn_id)
        self.plane.relinquish_computerless_ownership(self.tenant_id, self.turn_id)
        claimed = self.plane.claim_turn_attempt(
            self.tenant_id, self.turn_id, "computer-worker"
        )
        assert claimed is not None and claimed.acquired
        self.plane.record_attempt_claimed(self.tenant_id, self.turn_id)
        assert self.plane.claim_computer_for_turn(
            self.tenant_id, self.turn_id, "computer-worker"
        )
        unresolved = self.plane.unresolved_tool_action_ids(self.tenant_id, self.turn_id)
        if unresolved:
            self.plane.execute_pending_computer_action(self.tenant_id, self.turn_id)
        self.plane.commit_computer_tool_result(self.tenant_id, self.turn_id, "opened")
        turn = self.plane.turn(self.tenant_id, self.turn_id)
        self.plane._complete_turn(turn, expected_fence=turn.fence_token)
        return self._outcome(computer_reclaimed=False)

    def recover(self) -> StructuredHandoffOutcome:
        """Continue from the journal, reclaiming the computer when the lease died."""
        assert self.turn_id is not None
        assert self.computer_id is not None
        record = self.plane.escalation_for(self.tenant_id, self.turn_id)
        computer_reclaimed = False
        if (
            record.call_committed
            and record.computerless_relinquished
            and not record.result_committed
            and self.plane.active_computer_controllers(self.computer_id) == []
        ):
            claimed = self.plane.claim_turn_attempt(
                self.tenant_id, self.turn_id, "computer-reclaim-worker"
            )
            if claimed is None:
                raise EscalationCrash(EscalationBoundary.AFTER_COMPUTER_LEASE_EXPIRED)
            if claimed.acquired:
                self.plane.record_attempt_claimed(self.tenant_id, self.turn_id)
            if not self.plane.claim_computer_for_turn(
                self.tenant_id, self.turn_id, "computer-reclaim-worker"
            ):
                raise EscalationCrash(EscalationBoundary.AFTER_COMPUTER_LEASE_EXPIRED)
            computer_reclaimed = True
            unresolved = self.plane.unresolved_tool_action_ids(
                self.tenant_id, self.turn_id
            )
            if unresolved and record.computer_action_count == 0:
                self.plane.execute_pending_computer_action(self.tenant_id, self.turn_id)
            if not record.result_committed:
                self.plane.commit_computer_tool_result(
                    self.tenant_id, self.turn_id, record.result_body or "opened"
                )
            turn = self.plane.turn(self.tenant_id, self.turn_id)
            self.plane._complete_turn(turn, expected_fence=turn.fence_token)
        else:
            self.plane.recover_computer_escalation(self.tenant_id, self.turn_id)
        outcome = self._outcome(computer_reclaimed=computer_reclaimed)
        self.plane.advance_seconds(self.plane.attempt_lease.total_seconds() + 1)
        self.plane.expire_orphaned_computer_claims()
        outcome.orphan_claim_expired = (
            self.plane.active_computer_controllers(self.computer_id) == []
        )
        return outcome

    def _outcome(self, *, computer_reclaimed: bool) -> StructuredHandoffOutcome:
        assert self.turn_id is not None
        assert self.computer_id is not None
        turn = self.plane.turn(self.tenant_id, self.turn_id)
        record = self.plane.escalation_for(self.tenant_id, self.turn_id)
        events = self.plane.list_turn_events(self.tenant_id, self.turn_id)
        pending_once = record.computer_action_count == 1 and record.result_committed
        ended_visibly = turn.status in {TurnStatus.COMPLETED, TurnStatus.FAILED}
        return StructuredHandoffOutcome(
            turn_status=turn.status,
            pending_continued_once=pending_once,
            computer_action_count=record.computer_action_count,
            computer_controllers=self.plane.active_computer_controllers(
                self.computer_id
            ),
            orphan_claim_expired=False,
            ended_visibly=ended_visibly,
            journal_kinds=[event.kind for event in events],
            unresolved_action_ids=self.plane.unresolved_tool_action_ids(
                self.tenant_id, self.turn_id
            ),
            computer_reclaimed=computer_reclaimed,
            executed_action_id=record.executed_action_id,
            continuation_attempt_id=turn.attempt_id,
        )


def journal_has_typed_handoff(kinds: list[str]) -> bool:
    """Return whether model, tool, and attempt events are present as kinds."""
    required = {
        TurnEventKind.MODEL_REQUEST,
        TurnEventKind.TOOL_CALL,
        TurnEventKind.TOOL_RESULT,
        TurnEventKind.ATTEMPT_CLAIMED,
        TurnEventKind.ATTEMPT_RELINQUISHED,
    }
    return required.issubset(set(kinds))
