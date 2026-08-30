"""Drive one computer handoff through injectable crash windows."""

from __future__ import annotations

from dataclasses import dataclass

from chatticus.control_plane import ControlPlane
from chatticus.escalation_handoff import EscalationBoundary, EscalationCrash
from chatticus.models import ActorKind, CostClass, TurnStatus, WorkerRegistration


@dataclass
class EscalationFaultOutcome:
    """Observed state after handoff recovery."""

    turn_status: TurnStatus
    pending_continued_once: bool
    computer_action_count: int
    computer_controllers: list[str]
    orphan_claim_expired: bool
    ended_visibly: bool


class EscalationHandoffDriver:
    """Set up a computerless turn and crash at one escalation boundary."""

    def __init__(self, plane: ControlPlane | None = None) -> None:
        self.plane = plane or ControlPlane()
        self.tenant_id = "anthus"
        self.user_id = "ryan"
        self.turn_id: str | None = None
        self.computer_id: str | None = None

    def given_ready_to_request_computer_tool(self) -> None:
        """Start an active computerless turn that has a prepared computer tool."""
        bot = self.plane.create_bot(self.tenant_id, self.user_id, "Assistant")
        channel = self.plane.create_channel(self.tenant_id, self.user_id, [bot.bot_id])
        _, started = self.plane.post_channel_message(
            channel.channel_id,
            self.tenant_id,
            ActorKind.HUMAN,
            self.user_id,
            "open the household browser",
            addressed_to_bot_id=bot.bot_id,
        )
        assert started is not None
        self.turn_id = started.turn_id
        claimed = self.plane.claim_turn_attempt(
            self.tenant_id, started.turn_id, "computerless-worker"
        )
        assert claimed is not None and claimed.acquired
        computer = self.plane.ensure_computer(self.tenant_id, self.user_id)
        self.computer_id = computer.computer_id
        self.plane.register_worker(
            WorkerRegistration(
                worker_id="computer-worker",
                tenant_id=self.tenant_id,
                cost_class=CostClass.FARGATE,
                capabilities=frozenset({"cpu", "computer", "browser"}),
                computer_id=computer.computer_id,
            )
        )
        self.plane.prepare_computer_tool(
            self.tenant_id,
            started.turn_id,
            tool_name="browser_open",
            arguments={"url": "https://mail.example"},
        )

    def crash_at(self, boundary: EscalationBoundary) -> None:
        """Walk the handoff until ``boundary``, then stop."""
        assert self.turn_id is not None
        turn_id = self.turn_id
        if boundary is EscalationBoundary.BEFORE_TOOL_CALL_COMMITTED:
            raise EscalationCrash(boundary)
        self.plane.commit_pending_computer_tool(self.tenant_id, turn_id)
        if boundary is EscalationBoundary.AFTER_COMMIT_BEFORE_ENQUEUE:
            raise EscalationCrash(boundary)
        self.plane.enqueue_computer_continuation(self.tenant_id, turn_id)
        if boundary is EscalationBoundary.AFTER_ENQUEUE_BEFORE_RELINQUISH:
            raise EscalationCrash(boundary)
        self.plane.relinquish_computerless_ownership(self.tenant_id, turn_id)
        self.plane.claim_turn_attempt(self.tenant_id, turn_id, "computer-worker")
        self.plane.claim_computer_for_turn(self.tenant_id, turn_id, "computer-worker")
        self.plane.execute_pending_computer_action(self.tenant_id, turn_id)
        if boundary is EscalationBoundary.AFTER_ACTION_BEFORE_RESULT:
            raise EscalationCrash(boundary)
        self.plane.commit_computer_tool_result(self.tenant_id, turn_id, "opened")

    def recover(self) -> EscalationFaultOutcome:
        """Continue from durable handoff state, then expire an orphan claim."""
        assert self.turn_id is not None
        assert self.computer_id is not None
        self.plane.recover_computer_escalation(self.tenant_id, self.turn_id)
        turn = self.plane.turn(self.tenant_id, self.turn_id)
        record = self.plane.escalation_for(self.tenant_id, self.turn_id)
        pending_once = record.computer_action_count == 1 and record.result_committed
        ended_visibly = turn.status in {TurnStatus.COMPLETED, TurnStatus.FAILED}
        controllers = self.plane.active_computer_controllers(self.computer_id)
        self.plane.advance_seconds(self.plane.attempt_lease.total_seconds() + 1)
        self.plane.expire_orphaned_computer_claims()
        orphan_expired = self.plane.active_computer_controllers(self.computer_id) == []
        return EscalationFaultOutcome(
            turn_status=turn.status,
            pending_continued_once=pending_once,
            computer_action_count=record.computer_action_count,
            computer_controllers=controllers,
            orphan_claim_expired=orphan_expired,
            ended_visibly=ended_visibly,
        )
