"""Computerless worker: one OpenAI text-only loop per turn job."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

from chatticus.control_plane import ControlPlane
from chatticus.http.client import HttpTurnClient
from chatticus.models import TurnJob, TurnStatus


@dataclass(frozen=True)
class CompletionOutcome:
    """One model step: text to stream, and an optional readiness wait."""

    text: str
    wait_gate: str | None = None


class TextCompletionClient(Protocol):
    """Minimal OpenAI-shaped client for one text completion."""

    def complete(self, prompt: str) -> CompletionOutcome:
        """Return the model's text answer and any capability wait."""


class FakeTextCompletionClient:
    """Deterministic stand-in so CI never needs a live OpenAI key."""

    def complete(self, prompt: str) -> CompletionOutcome:
        """Echo a short answer derived from the last line of the prompt."""
        last_line = prompt.strip().splitlines()[-1] if prompt.strip() else ""
        lowered = last_line.lower()
        user_text = last_line
        for prefix in ("human:", "user:", "bot:"):
            if lowered.startswith(prefix):
                user_text = last_line.split(":", 1)[1].strip()
                lowered = user_text.lower()
                break
        if "open the household browser" in lowered:
            return CompletionOutcome(
                text="Here is a draft before I open the browser.",
                wait_gate="browser",
            )
        if user_text:
            return CompletionOutcome(text=f"You said: {user_text}")
        return CompletionOutcome(text="Hello")


class CountingTextCompletionClient:
    """Wrap a completion client and count how many times the model is called."""

    def __init__(self, inner: TextCompletionClient | None = None) -> None:
        self.inner = inner or FakeTextCompletionClient()
        self.calls = 0

    def complete(self, prompt: str) -> CompletionOutcome:
        """Count one model call, then delegate."""
        self.calls += 1
        return self.inner.complete(prompt)


class SlowTextCompletionClient:
    """Simulate a long model call for lease-renewal behavior specs."""

    def __init__(
        self,
        inner: TextCompletionClient | None = None,
        *,
        plane: ControlPlane | None = None,
        advance_seconds: int = 0,
    ) -> None:
        self.inner = inner or FakeTextCompletionClient()
        self.plane = plane
        self.advance_seconds = advance_seconds
        self.blocking_hook: Callable[[], None] | None = None

    def complete(self, prompt: str) -> CompletionOutcome:
        """Renew during the blocking window, then return the model answer."""
        if self.plane is not None and self.advance_seconds:
            mid = self.advance_seconds // 2
            if mid:
                self.plane.advance_seconds(mid)
        if self.blocking_hook is not None:
            self.blocking_hook()
        if self.plane is not None and self.advance_seconds:
            tail = self.advance_seconds - (self.advance_seconds // 2)
            if tail:
                self.plane.advance_seconds(tail)
        return self.inner.complete(prompt)


class ComputerlessWorker:
    """Pull cpu-only jobs, stream coalesced chunks, commit one answer."""

    def __init__(
        self,
        plane: ControlPlane,
        turn_client: HttpTurnClient,
        completion_client: TextCompletionClient | None = None,
        *,
        queue_visibility_renewer: Callable[[], None] | None = None,
    ) -> None:
        self.plane = plane
        self.turn_client = turn_client
        self._queue_visibility_renewer = queue_visibility_renewer
        if completion_client is None:
            from chatticus.worker.openai_completion import completion_client_from_env

            completion_client = completion_client_from_env()
        self.completion_client = completion_client

    def complete_pending_for_bot(self, bot_id: str) -> None:
        """Run every queued cpu job for one bot."""
        jobs = list(self.plane.pending_jobs_for_bot(bot_id))
        for job in jobs:
            self.run_job(job)

    def run_job(self, job: TurnJob) -> None:
        """Execute one turn: model loop, chunks via HTTP, one committed message."""
        if job.turn_id is None:
            return
        turn = self.plane.turn(job.tenant_id, job.turn_id)
        if turn.status != TurnStatus.ACTIVE:
            return
        if turn.waiting_for is not None:
            self.plane.remove_pending_job(job.job_id)
            return
        claimed = self.turn_client.claim(job.turn_id, job.job_id)
        if not claimed.get("acquired"):
            return
        prompt = self.plane.turn_prompt(job.tenant_id, job.turn_id)

        def renew() -> None:
            self._renew_lease(job)

        client = self.completion_client
        if isinstance(client, SlowTextCompletionClient):
            client.blocking_hook = renew
        renew()
        outcome = client.complete(prompt)
        if not outcome.text.strip() and outcome.wait_gate is None:
            raise RuntimeError("Model returned an empty completion.")
        if outcome.wait_gate is not None:
            if outcome.text.strip():
                self.turn_client.post_chunk(job.turn_id, outcome.text)
            self.turn_client.post_waiting(job.turn_id, outcome.wait_gate)
            self.plane.remove_pending_job(job.job_id)
            return
        midpoint = max(1, len(outcome.text) // 2)
        self.turn_client.post_chunk(job.turn_id, outcome.text[:midpoint])
        self.turn_client.post_chunk(job.turn_id, outcome.text[midpoint:], complete=True)
        self.plane.remove_pending_job(job.job_id)

    def _renew_lease(self, job: TurnJob) -> None:
        """Extend the turn lease and, when wired, SQS visibility."""
        if job.turn_id is None:
            return
        self.turn_client.renew(job.turn_id, job.job_id, job_id=job.job_id)
        if self._queue_visibility_renewer is not None:
            self._queue_visibility_renewer()
