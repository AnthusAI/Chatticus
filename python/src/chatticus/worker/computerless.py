"""Computerless worker: one OpenAI text-only loop per turn job."""

from __future__ import annotations

from typing import Protocol

from chatticus.control_plane import ControlPlane
from chatticus.models import TurnJob, TurnStatus


class TextCompletionClient(Protocol):
    """Minimal OpenAI-shaped client for one text completion."""

    def complete(self, prompt: str) -> str:
        """Return the model's text answer for a prompt."""


class FakeTextCompletionClient:
    """Deterministic stand-in so CI never needs a live OpenAI key."""

    def complete(self, prompt: str) -> str:
        """Echo a short answer derived from the last line of the prompt."""
        last_line = prompt.strip().splitlines()[-1] if prompt.strip() else ""
        lowered = last_line.lower()
        for prefix in ("human:", "user:", "bot:"):
            if lowered.startswith(prefix):
                user_text = last_line.split(":", 1)[1].strip()
                if user_text:
                    return f"You said: {user_text}"
        return "Hello"


class ComputerlessWorker:
    """Pull cpu-only jobs, stream coalesced chunks, commit one answer."""

    def __init__(
        self,
        plane: ControlPlane,
        completion_client: TextCompletionClient | None = None,
    ) -> None:
        self.plane = plane
        self.completion_client = completion_client or FakeTextCompletionClient()

    def complete_pending_for_bot(self, bot_id: str) -> None:
        """Run every queued cpu job for one bot."""
        jobs = list(self.plane.pending_jobs_for_bot(bot_id))
        for job in jobs:
            self.run_job(job)

    def run_job(self, job: TurnJob) -> None:
        """Execute one turn: model loop, chunks, one committed message."""
        if job.turn_id is None:
            return
        turn = self.plane.turn(job.tenant_id, job.turn_id)
        if turn.status != TurnStatus.ACTIVE:
            return
        prompt = self.plane.turn_prompt(job.tenant_id, job.turn_id)
        answer = self.completion_client.complete(prompt)
        midpoint = max(1, len(answer) // 2)
        self.plane.post_turn_chunk(job.turn_id, job.tenant_id, answer[:midpoint])
        self.plane.post_turn_chunk(
            job.turn_id, job.tenant_id, answer[midpoint:], complete=True
        )
        self.plane.remove_pending_job(job.job_id)
