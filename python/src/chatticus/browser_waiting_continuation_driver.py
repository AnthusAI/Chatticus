"""Prepare a browser-waiting turn with a queued computer continuation job."""

from __future__ import annotations

from dataclasses import dataclass

from chatticus.computer_capabilities import BROWSER_CAPABILITY
from chatticus.control_plane import ControlPlane
from chatticus.models import ActorKind, TurnJob


@dataclass
class BrowserWaitingContinuationSetup:
    """One browser-gated turn ready for a computer-capable pull worker."""

    tenant_id: str
    user_id: str
    turn_id: str
    continuation_job: TurnJob
    pending_action_id: str


def prepare_browser_waiting_continuation(
    plane: ControlPlane,
    *,
    tenant_id: str = "anthus",
    user_id: str = "ryan",
) -> BrowserWaitingContinuationSetup:
    """Block one turn on the browser gate and enqueue its continuation job."""
    bot = plane.create_bot(tenant_id, "Researcher", creator_user_id=user_id)
    channel = plane.create_channel(tenant_id, user_id, [bot.bot_id])
    _, turn = plane.post_channel_message(
        channel.channel_id,
        tenant_id,
        ActorKind.HUMAN,
        user_id,
        "open the household browser",
        addressed_to_bot_id=bot.bot_id,
    )
    assert turn is not None
    turn_id = turn.turn_id
    claimed = plane.claim_turn_attempt(tenant_id, turn_id, "waiting-worker")
    assert claimed is not None and claimed.acquired
    fence_token = claimed.fence_token
    plane.post_turn_chunk(
        turn_id,
        tenant_id,
        "Here is a draft.",
        fence_token=fence_token,
    )
    plane.emit_turn_waiting(tenant_id, turn_id, "browser", fence_token=fence_token)
    plane.release_turn_claim_for_waiting(tenant_id, turn_id, fence_token=fence_token)
    plane.set_computer_stopped(tenant_id, False)
    plane.record_computer_capability_ready(tenant_id, user_id, BROWSER_CAPABILITY)
    job = plane.resume_waiting_turn(tenant_id, turn_id)
    turn = plane.turn(tenant_id, turn_id)
    pending_action_id = turn.pending_computer_action_id
    assert pending_action_id is not None
    assert "computer" in job.required_capabilities
    return BrowserWaitingContinuationSetup(
        tenant_id=tenant_id,
        user_id=user_id,
        turn_id=turn_id,
        continuation_job=job,
        pending_action_id=pending_action_id,
    )
