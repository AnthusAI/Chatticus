"""Capability-gated readiness for mid-turn computer escalation.

A turn may perform useful computerless work before a browser step. When
blocked on a capability the household computer has not finished booting,
the turn emits ``turn.waiting`` naming that gate and does not claim the
browser work is complete. The same durable turn continues once the
capability becomes ready.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from chatticus.computer_capabilities import (
    BROWSER_CAPABILITY,
    ComputerCapabilityReadiness,
)
from chatticus.control_plane import ControlPlane
from chatticus.models import (
    ActorKind,
    TurnEventKind,
    TurnStatus,
)


@dataclass(frozen=True)
class TurnWorkPhase:
    """One unit of work in a turn, optionally gated on a capability."""

    name: str
    output: str
    required_capability: str | None = None


@dataclass
class CapabilityGatedTurnState:
    """Observed progress for one capability-gated turn."""

    turn_id: str
    preparatory_output: str | None = None
    waiting_for: str | None = None
    waiting_emitted: bool = False
    browser_claimed_complete: bool = False
    continued_same_turn: bool = False
    completed_turn_id: str | None = None
    emitted_gates: list[str] = field(default_factory=list)


class CapabilityGatedTurnDriver:
    """Drive one turn that does preparatory work before a browser step."""

    def __init__(self, plane: ControlPlane | None = None) -> None:
        self.plane = plane or ControlPlane()
        self.readiness = ComputerCapabilityReadiness()
        self.state: CapabilityGatedTurnState | None = None
        self._phases: list[TurnWorkPhase] = []
        self.tenant_id = "anthus"
        self.user_id = "ryan"
        self.turn_id: str | None = None

    def given_stopped_computer(self) -> None:
        """Mark the household computer stopped with no capability gates ready."""
        self.plane.set_computer_stopped(self.tenant_id, True)
        self.readiness = ComputerCapabilityReadiness(
            model_ready=False,
            workspace_ready=False,
            browser_ready=False,
        )

    def given_preparatory_then_browser_work(
        self,
        *,
        preparatory_output: str = "Here is a draft before I open the browser.",
        browser_tool: str = "browser_open",
    ) -> None:
        """Record work that needs no computer before a browser step."""
        self._phases = [
            TurnWorkPhase(
                name="preparatory",
                output=preparatory_output,
                required_capability=None,
            ),
            TurnWorkPhase(
                name=browser_tool,
                output="browser-opened",
                required_capability=BROWSER_CAPABILITY,
            ),
        ]

    def begin_turn(self) -> CapabilityGatedTurnState:
        """Start the turn, run computerless work, and wait at the browser gate."""
        if not self._phases:
            msg = "Turn work plan is not configured."
            raise ValueError(msg)
        bot = self.plane.create_bot(
            self.tenant_id, "Assistant", creator_user_id=self.user_id
        )
        channel = self.plane.create_channel(self.tenant_id, self.user_id, [bot.bot_id])
        _, started = self.plane.post_channel_message(
            channel.channel_id,
            self.tenant_id,
            ActorKind.HUMAN,
            self.user_id,
            "research this and open the household browser",
            addressed_to_bot_id=bot.bot_id,
        )
        assert started is not None
        self.turn_id = started.turn_id
        claimed = self.plane.claim_turn_attempt(
            self.tenant_id, started.turn_id, "computerless-worker"
        )
        assert claimed is not None and claimed.acquired
        state = CapabilityGatedTurnState(turn_id=started.turn_id)
        for phase in self._phases:
            if phase.required_capability is None:
                self.plane.post_turn_chunk(
                    started.turn_id,
                    self.tenant_id,
                    phase.output,
                    fence_token=claimed.fence_token,
                )
                state.preparatory_output = phase.output
                continue
            if not self.readiness.is_ready(phase.required_capability):
                self.plane.emit_turn_waiting(
                    self.tenant_id,
                    started.turn_id,
                    phase.required_capability,
                    fence_token=claimed.fence_token,
                )
                self.plane.release_turn_claim_for_waiting(
                    self.tenant_id,
                    started.turn_id,
                    fence_token=claimed.fence_token,
                )
                state.waiting_for = phase.required_capability
                state.waiting_emitted = True
                state.emitted_gates.append(phase.required_capability)
                break
            state.browser_claimed_complete = True
        self.state = state
        return state

    def mark_computer_ready(self) -> None:
        """Clear capability gates after the household computer finishes booting."""
        self.plane.set_computer_stopped(self.tenant_id, False)
        self.readiness.workspace_ready = True
        self.readiness.browser_ready = True

    def continue_turn(self) -> CapabilityGatedTurnState:
        """Resume the same turn after the blocked capability becomes ready."""
        if self.state is None or self.turn_id is None:
            msg = "Turn has not begun."
            raise ValueError(msg)
        state = self.state
        if state.waiting_for is None:
            msg = "Turn is not waiting on a capability gate."
            raise ValueError(msg)
        if not self.readiness.is_ready(state.waiting_for):
            msg = f"Capability {state.waiting_for!r} is still not ready."
            raise ValueError(msg)
        turn = self.plane.turn(self.tenant_id, self.turn_id)
        assert turn.status == TurnStatus.ACTIVE
        claimed = self.plane.claim_turn_attempt(
            self.tenant_id, self.turn_id, "computer-worker"
        )
        assert claimed is not None and claimed.acquired
        for phase in self._phases:
            if phase.required_capability == state.waiting_for:
                self.plane.post_turn_chunk(
                    self.turn_id,
                    self.tenant_id,
                    phase.output,
                    fence_token=claimed.fence_token,
                    complete=True,
                )
                state.browser_claimed_complete = True
                break
        state.continued_same_turn = True
        state.completed_turn_id = state.turn_id
        state.waiting_for = None
        return state

    def turn_waiting_gates(self) -> list[str]:
        """Return gate names recorded in ``turn.waiting`` events for this turn."""
        if self.turn_id is None:
            return []
        events = self.plane.list_turn_events(self.tenant_id, self.turn_id)
        return [
            event.body
            for event in events
            if event.kind == TurnEventKind.TURN_WAITING and event.body
        ]

    def preparatory_emitted_before_waiting(self) -> bool:
        """Return whether preparatory tokens preceded the first waiting event."""
        if self.turn_id is None:
            return False
        events = self.plane.list_turn_events(self.tenant_id, self.turn_id)
        saw_token = False
        for event in events:
            if event.kind == TurnEventKind.TURN_TOKEN:
                saw_token = True
            if event.kind == TurnEventKind.TURN_WAITING:
                return saw_token
        return False

    def turn_completed(self) -> bool:
        """Return whether the turn reached a committed answer."""
        if self.turn_id is None:
            return False
        turn = self.plane.turn(self.tenant_id, self.turn_id)
        return turn.status == TurnStatus.COMPLETED
