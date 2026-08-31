"""Drive two concurrent turns onto one stopped household computer."""

from __future__ import annotations

from dataclasses import dataclass

from chatticus.control_plane import ControlPlane
from chatticus.models import ActorKind


@dataclass
class SingleComputerStartOutcome:
    """Observed start-claim state after two concurrent requests."""

    host_start_count: int
    computer_ids: list[str]
    waiting_turn_ids: list[str]
    write_host_a: bool
    write_host_b: bool
    live_writer_host_id: str | None


class SingleComputerStartDriver:
    """Two eligible turns request one stopped computer."""

    def __init__(self, plane: ControlPlane | None = None) -> None:
        self.plane = plane or ControlPlane()
        self.tenant_id = "anthus"
        self.user_id = "ryan"
        self.outcome: SingleComputerStartOutcome | None = None

    def given_stopped_computer(self) -> None:
        """Ensure the household computer exists and is stopped."""
        self.plane.set_computer_stopped(self.tenant_id, self.user_id, True)

    def request_two_turns_concurrently(self) -> SingleComputerStartOutcome:
        """Issue two start requests without an intervening host boot."""
        researcher = self.plane.create_bot(self.tenant_id, self.user_id, "Researcher")
        writer = self.plane.create_bot(self.tenant_id, self.user_id, "Writer")
        channel = self.plane.create_channel(
            self.tenant_id, self.user_id, [researcher.bot_id, writer.bot_id]
        )
        _, first = self.plane.post_channel_message(
            channel.channel_id,
            self.tenant_id,
            ActorKind.HUMAN,
            self.user_id,
            "research this",
            addressed_to_bot_id=researcher.bot_id,
        )
        _, second = self.plane.post_channel_message(
            channel.channel_id,
            self.tenant_id,
            ActorKind.HUMAN,
            self.user_id,
            "draft from that",
            addressed_to_bot_id=writer.bot_id,
        )
        assert first is not None and second is not None
        claim_a = self.plane.request_computer_host_start(
            self.tenant_id, self.user_id, first.turn_id
        )
        claim_b = self.plane.request_computer_host_start(
            self.tenant_id, self.user_id, second.turn_id
        )
        write_a = self.plane.acquire_computer_disk_write(claim_a.computer_id, "host-a")
        write_b = self.plane.acquire_computer_disk_write(claim_b.computer_id, "host-b")
        claim = self.plane.host_start_claim(self.tenant_id, self.user_id)
        outcome = SingleComputerStartOutcome(
            host_start_count=claim.host_start_count,
            computer_ids=[claim_a.computer_id, claim_b.computer_id],
            waiting_turn_ids=list(claim.waiting_turn_ids),
            write_host_a=write_a,
            write_host_b=write_b,
            live_writer_host_id=claim.live_writer_host_id,
        )
        self.outcome = outcome
        return outcome
