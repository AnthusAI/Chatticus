"""Computerless worker: one OpenAI text-only loop per turn job."""

from __future__ import annotations

import re
import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

from chatticus.control_plane import ControlPlane
from chatticus.http.client import HttpTurnClient
from chatticus.models import (
    ComputerlessCannotExecuteComputerJob,
    TurnJob,
    TurnStatus,
    primary_human_participant,
)
from chatticus.vendor_ledger import (
    BILLED_VIA_VENDOR,
    CompletionUsage,
    fake_openai_completion_usage,
)
from chatticus.worker.tool_dispatch import (
    GatedToolCall,
    ToolDispatchResult,
    dispatch_gated_tool,
)


@dataclass(frozen=True)
class TaskToolCall:
    """One structured task-tool invocation from the model."""

    action: str
    arguments: dict[str, str]


@dataclass(frozen=True)
class CompletionOutcome:
    """One model step: text to stream, and optional tool side effects."""

    text: str
    usage: CompletionUsage
    wait_gate: str | None = None
    task_tool_call: TaskToolCall | None = None
    gated_tool_call: GatedToolCall | None = None


class TextCompletionClient(Protocol):
    """Minimal OpenAI-shaped client for one text completion."""

    def complete(self, prompt: str) -> CompletionOutcome:
        """Return the model's text answer and any capability wait."""


class FakeTextCompletionClient:
    """Deterministic stand-in so CI never needs a live OpenAI key."""

    def __init__(self, *, model: str = "gpt-5.6-luna") -> None:
        self.model = model

    def complete(self, prompt: str) -> CompletionOutcome:
        """Echo a short answer derived from the last line of the prompt."""
        usage = fake_openai_completion_usage(model=self.model)
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
                usage=usage,
                wait_gate="browser",
            )
        if user_text:
            return CompletionOutcome(
                text=f"You said: {user_text}",
                usage=usage,
            )
        return CompletionOutcome(text="Hello", usage=usage)


class TaskAwareFakeTextCompletionClient(FakeTextCompletionClient):
    """Fake client that can emit task-tool calls for Gherkin and kernel tests."""

    _TASK_TITLE_RE = re.compile(
        r"create a task titled (.+)$",
        re.IGNORECASE,
    )

    def complete(self, prompt: str) -> CompletionOutcome:
        last_line = prompt.strip().splitlines()[-1] if prompt.strip() else ""
        lowered = last_line.lower()
        user_text = last_line
        for prefix in ("human:", "user:", "bot:"):
            if lowered.startswith(prefix):
                user_text = last_line.split(":", 1)[1].strip()
                lowered = user_text.lower()
                break
        match = self._TASK_TITLE_RE.search(user_text)
        if match is not None:
            title = match.group(1).strip()
            return CompletionOutcome(
                text="I'll create that task for you.",
                usage=fake_openai_completion_usage(model=self.model),
                task_tool_call=TaskToolCall(
                    action="create",
                    arguments={"title": title},
                ),
            )
        return super().complete(prompt)


class CapabilityAwareFakeTextCompletionClient(FakeTextCompletionClient):
    """Fake client that emits first-gate tool calls for Gherkin sink specs."""

    _READ_WORKSPACE_RE = re.compile(
        r"read workspace file (.+)$",
        re.IGNORECASE,
    )
    _BROWSE_RE = re.compile(
        r"browse (https?://\S+)",
        re.IGNORECASE,
    )
    _SEND_RE = re.compile(
        r"send (\S+)",
        re.IGNORECASE,
    )
    _PURCHASE_RE = re.compile(
        r"purchase item (\S+) from (\S+)",
        re.IGNORECASE,
    )

    def complete(self, prompt: str) -> CompletionOutcome:
        last_line = prompt.strip().splitlines()[-1] if prompt.strip() else ""
        lowered = last_line.lower()
        user_text = last_line
        for prefix in ("human:", "user:", "bot:"):
            if lowered.startswith(prefix):
                user_text = last_line.split(":", 1)[1].strip()
                lowered = user_text.lower()
                break
        read_match = self._READ_WORKSPACE_RE.search(user_text)
        if read_match is not None:
            path = read_match.group(1).strip()
            return CompletionOutcome(
                text="I'll read that workspace file.",
                usage=fake_openai_completion_usage(model=self.model),
                gated_tool_call=GatedToolCall(
                    tool_name="read_workspace",
                    arguments={"path": path},
                ),
            )
        browse_match = self._BROWSE_RE.search(user_text)
        if browse_match is not None:
            url = browse_match.group(1).strip()
            return CompletionOutcome(
                text="I'll check that origin.",
                usage=fake_openai_completion_usage(model=self.model),
                gated_tool_call=GatedToolCall(
                    tool_name="browse",
                    arguments={"url": url},
                ),
            )
        send_match = self._SEND_RE.search(user_text)
        if send_match is not None:
            recipient = send_match.group(1).strip()
            return CompletionOutcome(
                text="I'll try to send that message.",
                usage=fake_openai_completion_usage(model=self.model),
                gated_tool_call=GatedToolCall(
                    tool_name="send",
                    arguments={"recipient": recipient},
                ),
            )
        purchase_match = self._PURCHASE_RE.search(user_text)
        if purchase_match is not None:
            sku = purchase_match.group(1).strip()
            destination = purchase_match.group(2).strip()
            return CompletionOutcome(
                text="I'll try to complete that purchase.",
                usage=fake_openai_completion_usage(model=self.model),
                gated_tool_call=GatedToolCall(
                    tool_name="purchase",
                    arguments={"destination": destination, "sku": sku},
                ),
            )
        return super().complete(prompt)


class CountingTextCompletionClient:
    """Wrap a completion client and count how many times the model is called."""

    def __init__(self, inner: TextCompletionClient | None = None) -> None:
        self.inner = inner or FakeTextCompletionClient()
        self.calls = 0

    def complete(self, prompt: str) -> CompletionOutcome:
        """Count one model call, then delegate."""
        self.calls += 1
        return self.inner.complete(prompt)


class RenewingTextCompletionClient:
    """Renew the turn lease while a blocking completion call runs."""

    def __init__(
        self,
        inner: TextCompletionClient,
        renew: Callable[[], None],
        *,
        interval_seconds: float = 30.0,
    ) -> None:
        self.inner = inner
        self._renew = renew
        self._interval_seconds = interval_seconds

    def complete(self, prompt: str) -> CompletionOutcome:
        """Call the model while renewing the lease on a fixed interval."""
        stop = threading.Event()

        def renew_loop() -> None:
            while not stop.wait(self._interval_seconds):
                self._renew()

        self._renew()
        thread = threading.Thread(target=renew_loop, daemon=True)
        thread.start()
        try:
            return self.inner.complete(prompt)
        finally:
            stop.set()
            thread.join(timeout=1.0)


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
        """Execute one cpu turn: model loop, chunks via HTTP, one committed message.

        A job that requires ``computer`` is refused without removing it from
        the queue. Waiting-turn skip applies only to cpu redelivery so a
        computer continuation is not acked by this worker.
        """
        if job.turn_id is None:
            return
        if "computer" in job.required_capabilities:
            msg = (
                f"Computerless worker cannot execute job {job.job_id!r} "
                f"that requires computer capability."
            )
            raise ComputerlessCannotExecuteComputerJob(msg)
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
        else:
            outcome = RenewingTextCompletionClient(client, renew).complete(prompt)
        self.plane.record_vendor_spend(
            job.tenant_id,
            job.turn_id,
            outcome.usage,
            billed_via=BILLED_VIA_VENDOR,
        )
        if (
            not outcome.text.strip()
            and outcome.wait_gate is None
            and outcome.task_tool_call is None
            and outcome.gated_tool_call is None
        ):
            raise RuntimeError("Model returned an empty completion.")
        if outcome.gated_tool_call is not None:
            self._handle_gated_tool_call(job, outcome)
            return
        if outcome.task_tool_call is not None:
            self._handle_task_tool_call(job, outcome)
            return
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

    def _handle_gated_tool_call(self, job: TurnJob, outcome: CompletionOutcome) -> None:
        """Invoke one first-gate tool through ThinTurn HTTP sinks."""
        if job.turn_id is None or outcome.gated_tool_call is None:
            return
        turn = self.plane.turn(job.tenant_id, job.turn_id)
        bot_id = job.bot_id or turn.bot_id
        if bot_id is None:
            raise RuntimeError("Gated tool requires a bot-addressed turn.")
        user_id = self.plane.acting_member_user_id_for_turn(job.tenant_id, job.turn_id)
        result = dispatch_gated_tool(
            self.turn_client,
            turn_id=job.turn_id,
            user_id=user_id,
            call=outcome.gated_tool_call,
        )
        answer = self._answer_for_gated_tool(outcome.text, result)
        midpoint = max(1, len(answer) // 2)
        self.turn_client.post_chunk(job.turn_id, answer[:midpoint])
        self.turn_client.post_chunk(job.turn_id, answer[midpoint:], complete=True)
        self.plane.remove_pending_job(job.job_id)

    def _answer_for_gated_tool(self, draft: str, result: ToolDispatchResult) -> str:
        """Build one bot answer from a gated tool dispatch outcome."""
        prefix = draft.strip()
        if result.denied:
            detail = f"denied: {result.reason}"
            return f"{prefix} {detail}".strip()
        if result.content is not None and result.content:
            return f"{prefix} {result.content}".strip()
        return prefix or "Done."

    def _handle_task_tool_call(self, job: TurnJob, outcome: CompletionOutcome) -> None:
        """Invoke the structured task tool through ThinTurn HTTP and answer."""
        if job.turn_id is None or outcome.task_tool_call is None:
            return
        turn = self.plane.turn(job.tenant_id, job.turn_id)
        bot_id = job.bot_id or turn.bot_id
        if bot_id is None:
            raise RuntimeError("Task tool requires a bot-addressed turn.")
        channel = self.plane.channel(job.tenant_id, turn.channel_id)
        task = self.turn_client.invoke_task_tool(
            bot_id,
            primary_human_participant(channel),
            outcome.task_tool_call.action,
            outcome.task_tool_call.arguments,
        )
        answer = (
            f"{outcome.text.strip()} Task {task['task_id']}: "
            f"{task['title']} (status: {task['status']})."
        ).strip()
        midpoint = max(1, len(answer) // 2)
        self.turn_client.post_chunk(job.turn_id, answer[:midpoint])
        self.turn_client.post_chunk(job.turn_id, answer[midpoint:], complete=True)
        self.plane.remove_pending_job(job.job_id)

    def _renew_lease(self, job: TurnJob) -> None:
        """Extend the turn lease and, when wired, SQS visibility."""
        if job.turn_id is None:
            return
        self.turn_client.renew(job.turn_id, job.job_id, job_id=job.job_id)
        if self._queue_visibility_renewer is not None:
            self._queue_visibility_renewer()
