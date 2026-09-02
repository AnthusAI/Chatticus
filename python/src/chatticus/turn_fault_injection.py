"""Deterministic crash windows around durable turn boundaries."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

from chatticus.control_plane import ControlPlane
from chatticus.models import ActorKind, TurnStatus
from chatticus.turn_fault_hooks import (
    CrashWindow,
    FaultInjector,
    SimulatedCrash,
    TurnBoundary,
)
from chatticus.turn_recovery import logical_enqueue_id
from chatticus.worker.computerless import (
    CountingTextCompletionClient,
    TextCompletionClient,
)


@dataclass
class TurnFaultOutcome:
    """Observed state after a fault scenario completes."""

    provider_calls: int
    human_messages: int
    bot_messages: int
    turn_status: TurnStatus
    recovery_attempts: int
    fence_token: int
    authoritative_workers: list[str]


def recovery_plane(*, fault_injector: FaultInjector | None = None) -> ControlPlane:
    """Control plane configured like turn-recovery behavior specs."""
    return ControlPlane(
        attempt_lease=timedelta(seconds=60),
        turn_deadline=timedelta(seconds=120),
        max_recovery_attempts=1,
        recovery_enabled=True,
        fault_injector=fault_injector,
    )


def assert_single_authoritative_actor(
    plane: ControlPlane, tenant_id: str, turn_id: str
) -> list[str]:
    """Return worker ids that currently hold an unexpired lease."""
    turn = plane.turn(tenant_id, turn_id)
    if turn.status != TurnStatus.ACTIVE:
        return []
    lease_valid = (
        turn.lease_expires_at is not None and turn.lease_expires_at > plane.now()
    )
    if lease_valid and turn.claimed_by_worker_id is not None:
        return [turn.claimed_by_worker_id]
    return []


class StepwiseTurnWorker:
    """Drive one job through injectable turn steps without duplicate model calls."""

    def __init__(
        self,
        plane: ControlPlane,
        completion_client: TextCompletionClient,
        *,
        fault_injector: FaultInjector | None = None,
        worker_id: str = "worker-a",
    ) -> None:
        self.plane = plane
        self.completion_client = completion_client
        self.fault_injector = fault_injector
        self.worker_id = worker_id
        self.fence_token: int | None = None
        self.cached_answer: str | None = None

    def _fault(self, boundary: TurnBoundary, window: CrashWindow) -> None:
        if self.fault_injector is not None:
            self.fault_injector.maybe_crash(boundary, window)

    def claim(self, job) -> bool:
        """Claim the turn and return whether this worker acquired ownership."""
        attempt = self.plane.claim_turn_attempt(
            job.tenant_id, job.turn_id, self.worker_id
        )
        if attempt is None:
            return False
        self.fence_token = attempt.fence_token
        return attempt.acquired

    def call_model(self, job) -> str:
        """Call the provider once and cache the answer for retries."""
        if self.cached_answer is not None:
            return self.cached_answer
        self._fault(TurnBoundary.MODEL_ACCEPTANCE, CrashWindow.BEFORE)
        prompt = self.plane.turn_prompt(job.tenant_id, job.turn_id)
        outcome = self.completion_client.complete(prompt)
        answer = outcome.text if hasattr(outcome, "text") else outcome
        self.cached_answer = answer
        self._fault(TurnBoundary.MODEL_ACCEPTANCE, CrashWindow.AFTER)
        return answer

    def post_progress(self, job, token: str) -> None:
        """Append one non-terminal chunk."""
        assert self.fence_token is not None
        self.plane.post_turn_chunk(
            job.turn_id,
            job.tenant_id,
            token,
            fence_token=self.fence_token,
        )

    def post_completion(self, job, token: str) -> None:
        """Append the final chunk and commit the bot answer."""
        assert self.fence_token is not None
        self.plane.post_turn_chunk(
            job.turn_id,
            job.tenant_id,
            token,
            complete=True,
            fence_token=self.fence_token,
        )

    def acknowledge(self, job) -> None:
        """Remove the pending job after a successful turn."""
        self.plane.remove_pending_job(job.job_id)

    def run_job(self, job) -> None:
        """Execute claim, model, progress, completion, and acknowledgement."""
        if job.turn_id is None:
            return
        turn = self.plane.turn(job.tenant_id, job.turn_id)
        if turn.status != TurnStatus.ACTIVE:
            return
        acquired = self.claim(job)
        if not acquired:
            if turn.claimed_by_worker_id != self.worker_id:
                return
            if self.fence_token is None:
                self.fence_token = turn.fence_token
        answer = self.call_model(job)
        midpoint = max(1, len(answer) // 2)
        self.post_progress(job, answer[:midpoint])
        self.post_completion(job, answer[midpoint:])
        self.acknowledge(job)


class TurnFaultDriver:
    """Run one turn through a crash window and recover deterministically."""

    def __init__(
        self,
        *,
        tenant_id: str = "anthus",
        user_id: str = "ryan",
        worker_id: str = "worker-a",
    ) -> None:
        self.tenant_id = tenant_id
        self.user_id = user_id
        self.worker_id = worker_id
        self.injector = FaultInjector()
        self.plane = recovery_plane(fault_injector=self.injector)
        self.counting_client = CountingTextCompletionClient()
        bot = self.plane.create_bot(tenant_id, "Assistant", creator_user_id=user_id)
        self.bot_id = bot.bot_id
        channel = self.plane.create_channel(tenant_id, user_id, [bot.bot_id])
        self.channel_id = channel.channel_id
        self.turn_id: str | None = None
        self.job = None
        self._human_body = "hello"
        self._worker_instance = StepwiseTurnWorker(
            self.plane,
            self.counting_client,
            fault_injector=self.injector,
            worker_id=self.worker_id,
        )

    def close(self) -> None:
        return

    def _worker(self) -> StepwiseTurnWorker:
        return self._worker_instance

    def _capture_turn_state(self) -> None:
        if self.turn_id is not None and self.job is not None:
            return
        turn = self.plane.active_turn_for_channel(self.tenant_id, self.channel_id)
        if turn is not None:
            self.turn_id = turn.turn_id
            self.job = self.plane.job_for_turn(self.tenant_id, self.turn_id)

    def _post_message(self) -> None:
        try:
            _, started = self.plane.post_channel_message(
                self.channel_id,
                self.tenant_id,
                ActorKind.HUMAN,
                self.user_id,
                self._human_body,
                addressed_to_bot_id=self.bot_id,
            )
        except SimulatedCrash:
            self._capture_turn_state()
            raise
        assert started is not None
        self.turn_id = started.turn_id
        self.job = self.plane.job_for_turn(self.tenant_id, self.turn_id)
        assert self.job is not None

    def _resume_turn_start(self) -> None:
        channel = self.plane.channel(self.tenant_id, self.channel_id)
        messages = self.plane.list_channel_messages(self.channel_id, self.tenant_id)
        prompt_seq = messages[-1].seq if messages else None
        started = self.plane._start_turn_for_bot(
            channel,
            self.bot_id,
            prompt_message_seq=prompt_seq,
        )
        self.turn_id = started.turn_id
        self.job = self.plane.job_for_turn(self.tenant_id, self.turn_id)
        assert self.job is not None

    def _retry_logical_enqueue(self) -> None:
        assert self.turn_id is not None and self.job is not None
        enqueue_id = logical_enqueue_id(self.turn_id)
        self.plane.request_logical_enqueue(
            self.tenant_id, self.turn_id, enqueue_id, self.job
        )

    def _setup_wedged_turn(self) -> None:
        self.injector.clear()
        self._post_message()
        worker = self._worker()
        assert worker.claim(self.job)
        worker.post_progress(self.job, "partial ")
        self.plane.advance_seconds(61)

    def drive_until_crash(self, boundary: TurnBoundary, window: CrashWindow) -> None:
        """Arm a crash and run until ``SimulatedCrash`` is raised."""
        if boundary == TurnBoundary.DEADLINE_RECOVERY:
            self._setup_wedged_turn()
            self.injector.arm(boundary, window)
            try:
                assert self.turn_id is not None
                self.plane.handle_turn_deadline(self.tenant_id, self.turn_id)
            except SimulatedCrash as crash:
                assert crash.boundary == boundary
                assert crash.window == window
                return
            raise AssertionError("Expected crash during deadline recovery.")
        self.injector.arm(boundary, window)
        if boundary in (TurnBoundary.MESSAGE_COMMIT, TurnBoundary.LOGICAL_ENQUEUE):
            try:
                self._post_message()
            except SimulatedCrash as crash:
                self._capture_turn_state()
                assert crash.boundary == boundary
                assert crash.window == window
                return
            raise AssertionError(f"Expected crash at {boundary} {window}.")
        self.injector.clear()
        self._post_message()
        self.injector.arm(boundary, window)
        try:
            self._worker().run_job(self.job)
        except SimulatedCrash as crash:
            self._capture_turn_state()
            assert crash.boundary == boundary
            assert crash.window == window
            return
        raise AssertionError(f"Expected crash at {boundary} {window}.")

    def _ensure_worker_fence(self, worker: StepwiseTurnWorker) -> None:
        if worker.fence_token is not None or self.turn_id is None:
            return
        turn = self.plane.turn(self.tenant_id, self.turn_id)
        worker.fence_token = turn.fence_token

    def _finish_answer(self, worker: StepwiseTurnWorker) -> None:
        self._ensure_worker_fence(worker)
        answer = worker.cached_answer
        assert answer is not None
        midpoint = max(1, len(answer) // 2)
        chunks = self.plane._messaging_store.list_turn_chunks(
            self.tenant_id, self.turn_id
        )
        if not chunks:
            worker.post_progress(self.job, answer[:midpoint])
            worker.post_completion(self.job, answer[midpoint:])
        elif len(chunks) == 1 and chunks[0] == answer[:midpoint]:
            worker.post_completion(self.job, answer[midpoint:])
        else:
            worker.post_completion(self.job, answer[midpoint:])
        worker.acknowledge(self.job)

    def recover_and_complete(
        self, boundary: TurnBoundary, window: CrashWindow
    ) -> TurnFaultOutcome:
        """Clear the fault hook and finish the turn from the crash snapshot."""
        self.injector.clear()
        worker = self._worker()
        if boundary == TurnBoundary.MESSAGE_COMMIT:
            if window == CrashWindow.BEFORE:
                self._post_message()
            else:
                self._resume_turn_start()
            worker.run_job(self.job)
        elif boundary == TurnBoundary.LOGICAL_ENQUEUE:
            if window == CrashWindow.BEFORE:
                self._retry_logical_enqueue()
            worker.run_job(self.job)
        elif boundary == TurnBoundary.WORKER_CLAIM:
            if window == CrashWindow.BEFORE:
                worker.run_job(self.job)
            else:
                self._ensure_worker_fence(worker)
                worker.call_model(self.job)
                self._finish_answer(worker)
        elif boundary == TurnBoundary.MODEL_ACCEPTANCE:
            if window == CrashWindow.BEFORE:
                worker.run_job(self.job)
            else:
                self._finish_answer(worker)
        elif boundary == TurnBoundary.PROGRESS_APPEND:
            if window == CrashWindow.BEFORE:
                worker.run_job(self.job)
            else:
                self._finish_answer(worker)
        elif boundary == TurnBoundary.COMPLETION_APPEND:
            if window == CrashWindow.BEFORE:
                worker.run_job(self.job)
            else:
                turn = self.plane.turn(self.tenant_id, self.turn_id)
                self.plane.complete_turn(
                    self.tenant_id,
                    self.turn_id,
                    fence_token=turn.fence_token,
                )
                worker.acknowledge(self.job)
        elif boundary == TurnBoundary.ACKNOWLEDGEMENT:
            if window == CrashWindow.BEFORE:
                worker.acknowledge(self.job)
        elif boundary == TurnBoundary.DEADLINE_RECOVERY:
            assert self.turn_id is not None
            if window == CrashWindow.BEFORE:
                self.plane.handle_turn_deadline(self.tenant_id, self.turn_id)
            else:
                turn = self.plane.turn(self.tenant_id, self.turn_id)
                recovery_job = self.plane.job_for_turn(self.tenant_id, self.turn_id)
                assert recovery_job is not None
                self.plane.request_logical_enqueue(
                    self.tenant_id,
                    self.turn_id,
                    logical_enqueue_id(
                        self.turn_id, recovery_attempt=turn.recovery_attempts
                    ),
                    recovery_job,
                )
            turn = self.plane.turn(self.tenant_id, self.turn_id)
            if turn.status == TurnStatus.ACTIVE:
                recovery_job = self.plane.job_for_turn(self.tenant_id, self.turn_id)
                assert recovery_job is not None
                self.job = recovery_job
                worker.run_job(recovery_job)
        return self.outcome()

    def outcome(self) -> TurnFaultOutcome:
        """Collect observable turn state for assertions."""
        assert self.turn_id is not None
        messages = self.plane.list_channel_messages(self.channel_id, self.tenant_id)
        human_messages = [
            message for message in messages if message.author_kind == ActorKind.HUMAN
        ]
        bot_messages = [
            message for message in messages if message.author_kind == ActorKind.BOT
        ]
        turn = self.plane.turn(self.tenant_id, self.turn_id)
        return TurnFaultOutcome(
            provider_calls=self.counting_client.calls,
            human_messages=len(human_messages),
            bot_messages=len(bot_messages),
            turn_status=turn.status,
            recovery_attempts=turn.recovery_attempts,
            fence_token=turn.fence_token,
            authoritative_workers=assert_single_authoritative_actor(
                self.plane, self.tenant_id, self.turn_id
            ),
        )


ALL_CRASH_SCENARIOS: list[tuple[TurnBoundary, CrashWindow]] = [
    (boundary, window) for boundary in TurnBoundary for window in CrashWindow
]
