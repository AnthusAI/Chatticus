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
        self.computer_id: str | None = "household-computer"
        self.outcome: SingleComputerStartOutcome | None = None
        self._last_turn_id: str | None = None
        self._selected_host: str | None = None

    def given_stopped_computer(self) -> None:
        """Ensure the household computer exists and is stopped."""
        if self.computer_id is not None:
            self.plane.ensure_computer(self.tenant_id, computer_id=self.computer_id)
        else:
            self.plane.ensure_computer(self.tenant_id)
        self.plane.set_computer_stopped(self.tenant_id, True)

    def _computer_id(self) -> str:
        return self.plane.computer_for_organization(self.tenant_id).computer_id

    def request_host_start(self) -> None:
        """Request one host start for a single turn."""
        bot_count = len(self.plane._bots)
        bot = self.plane.create_bot(
            self.tenant_id, f"Researcher-{bot_count + 1}", creator_user_id=self.user_id
        )
        channel = self.plane.create_channel(self.tenant_id, self.user_id, [bot.bot_id])
        _, turn = self.plane.post_channel_message(
            channel.channel_id,
            self.tenant_id,
            ActorKind.HUMAN,
            self.user_id,
            "start the computer",
            addressed_to_bot_id=bot.bot_id,
        )
        assert turn is not None
        self._last_turn_id = turn.turn_id
        self.plane.request_computer_host_start(self.tenant_id, turn.turn_id)

    def retry_host_start(self) -> None:
        """Retry the same turn's host start without expiring the claim."""
        assert self._last_turn_id is not None
        self.plane.request_computer_host_start(self.tenant_id, self._last_turn_id)

    def expire_host_start_lease(self) -> None:
        """Advance past the host-start lease without granting a live writer."""
        self.plane.advance_seconds(self.plane.attempt_lease.total_seconds() + 1)
        self.plane.expire_host_start_claims()

    def host_start_count(self) -> int:
        """Return the lifetime host-start count for the household computer."""
        computer = self.plane.computer_for_organization(self.tenant_id)
        return computer.host_start_generation

    def disk_write_lock_held(self) -> bool:
        """Return whether any host still holds the disk write lock."""
        computer = self.plane.computer_for_organization(self.tenant_id)
        key = (self.tenant_id, computer.computer_id)
        claim = self.plane._host_starts.get(key)
        if claim is None:
            return False
        return claim.live_writer_host_id is not None

    def set_local_reconciled_generation(self, generation: int) -> None:
        """Record the snapshot generation a local host last hydrated."""
        self.plane.reconcile_worker_snapshot(self.tenant_id, "garage-mac-1", generation)

    def publish_remote_snapshot_generation(self, generation: int) -> None:
        """Publish snapshots until the computer reaches one generation."""
        computer_id = self._computer_id()
        computer = self.plane.computer_for_organization(self.tenant_id)
        while computer.snapshot_generation < generation:
            self.plane.write_workspace(self.tenant_id, "notes.md", "published")
            self.plane.publish_snapshot(computer_id, "fargate-1")
            computer = self.plane.computer_for_organization(self.tenant_id)

    def select_start_host(self) -> str | None:
        """Choose which host should start the stopped computer."""
        self._selected_host = self.plane.select_computer_start_host(
            self.tenant_id, self.user_id
        )
        return self._selected_host

    def reconcile_local_host(self, generation: int) -> None:
        """Mark the local host caught up to one snapshot generation."""
        self.plane.reconcile_worker_snapshot(self.tenant_id, "garage-mac-1", generation)

    def request_two_turns_concurrently(self) -> SingleComputerStartOutcome:
        """Issue two start requests without an intervening host boot."""
        researcher = self.plane.create_bot(
            self.tenant_id, "Researcher", creator_user_id=self.user_id
        )
        writer = self.plane.create_bot(
            self.tenant_id, "Writer", creator_user_id=self.user_id
        )
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
        claim_a = self.plane.request_computer_host_start(self.tenant_id, first.turn_id)
        claim_b = self.plane.request_computer_host_start(self.tenant_id, second.turn_id)
        write_a = self.plane.acquire_computer_disk_write(claim_a.computer_id, "host-a")
        write_b = self.plane.acquire_computer_disk_write(claim_b.computer_id, "host-b")
        claim = self.plane.host_start_claim(self.tenant_id)
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
