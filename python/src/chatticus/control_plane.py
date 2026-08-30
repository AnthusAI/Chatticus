"""In-memory control plane: workers, routing, roster, approvals, messages."""

from __future__ import annotations

import hashlib
import json
import queue
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from chatticus.approval_binding import ApprovalBindingGate
from chatticus.escalation_handoff import (
    ComputerOwnershipClaim,
    EscalationRecord,
    PendingComputerToolCall,
)
from chatticus.messaging.store import (
    InMemoryMessagingStore,
    MessagingStore,
    default_chunk_expiry,
)
from chatticus.models import (
    AWS_COST_CLASSES,
    CONSEQUENTIAL_ACTION_TYPES,
    COST_CLASS_RANK,
    ActorKind,
    ActorNotInChannelError,
    ApprovalDecision,
    AutoReviewRule,
    AutoReviewRuleKind,
    Bot,
    Channel,
    ChannelNotFoundError,
    ChannelParticipant,
    ChannelTenantMismatchError,
    Computer,
    ComputerDirtyError,
    ComputerNotHydratedError,
    ComputerPolicy,
    ComputerSnapshot,
    CostClass,
    DuplicateBotNameError,
    Message,
    SnapshotRequiredError,
    StaleAttemptError,
    Turn,
    TurnAttempt,
    TurnEvent,
    TurnEventKind,
    TurnJob,
    TurnNotFoundError,
    TurnReconcilingError,
    TurnStatus,
    TurnTerminalError,
    WorkerDoesNotHostComputerError,
    WorkerRecord,
    WorkerRegistration,
    WorkerTenantMismatchError,
)
from chatticus.overnight_gated import (
    OvernightGatedResult,
    resolve_unattended_gated_action,
    resolve_unbound_authenticated_browser_action,
)
from chatticus.snapshot.uri import snapshot_uri
from chatticus.turn_fault_hooks import CrashWindow, FaultInjector, TurnBoundary
from chatticus.turn_recovery import (
    InMemoryTurnDeadlineScheduler,
    QueueVisibilityLedger,
    TurnDeadlineScheduler,
    logical_enqueue_id,
)


class ControlPlane:
    """Tenant-aware control plane used by the product behavior specs.

    This is the protocol kernel. HTTP, the realtime API, SQS, and the
    computer image sit on top of the same rules.
    """

    def __init__(
        self,
        heartbeat_timeout: timedelta | None = None,
        messaging_store: MessagingStore | None = None,
        turn_enqueued: Callable[[TurnJob], None] | None = None,
        attempt_lease: timedelta | None = None,
        turn_deadline: timedelta | None = None,
        max_recovery_attempts: int = 1,
        deadline_scheduler: TurnDeadlineScheduler | None = None,
        visibility_ledger: QueueVisibilityLedger | None = None,
        visibility_renewer: Callable[[TurnJob], None] | None = None,
        recovery_enabled: bool = False,
        wall_clock: bool = False,
        fault_injector: FaultInjector | None = None,
    ) -> None:
        """
        :param heartbeat_timeout: Stale workers are ignored after this interval.
        :type heartbeat_timeout: timedelta | None
        :param messaging_store: Durable channel and turn persistence.
        :type messaging_store: MessagingStore | None
        :param turn_enqueued: Optional hook that receives each cpu turn job
            after it is bound to a turn (used to publish SQS in Lambda).
        :type turn_enqueued: Callable[[TurnJob], None] | None
        :param attempt_lease: How long a claimed turn stays owned without renew.
        :type attempt_lease: timedelta | None
        :param turn_deadline: How long an active turn may run without renewal.
        :type turn_deadline: timedelta | None
        :param max_recovery_attempts: Recovery tries before a visible failure.
        :type max_recovery_attempts: int
        :param deadline_scheduler: Per-turn watchdog transport.
        :type deadline_scheduler: TurnDeadlineScheduler | None
        :param visibility_ledger: Records queue visibility renewals in tests.
        :type visibility_ledger: QueueVisibilityLedger | None
        :param visibility_renewer: Extends SQS visibility for one job.
        :type visibility_renewer: Callable[[TurnJob], None] | None
        :param recovery_enabled: Schedule deadlines and recover wedged turns.
        :type recovery_enabled: bool
        :param wall_clock: When true, ``_now`` is ``datetime.now(UTC)`` every
            read so a long-lived Lambda plane does not freeze EventBridge
            deadlines at import time. Tests keep the default pinned clock.
        :type wall_clock: bool
        :param fault_injector: Optional deterministic crash hooks for tests.
        :type fault_injector: FaultInjector | None
        """
        self.heartbeat_timeout = heartbeat_timeout or timedelta(seconds=30)
        self.attempt_lease = attempt_lease or timedelta(seconds=60)
        self.turn_deadline = turn_deadline or timedelta(seconds=120)
        self.max_recovery_attempts = max_recovery_attempts
        self.recovery_enabled = recovery_enabled
        self._wall_clock = wall_clock
        self._fault_injector = fault_injector
        self._frozen_now = datetime.now(UTC)
        self._workers: dict[str, WorkerRecord] = {}
        self._bots: dict[str, Bot] = {}
        self._computers_by_user: dict[tuple[str, str], Computer] = {}
        self._computers_by_id: dict[str, Computer] = {}
        self._snapshots: dict[str, ComputerSnapshot] = {}
        self._auto_review_rules: list[AutoReviewRule] = []
        self._refused_bot_auto_review: list[tuple[str, str]] = []
        self._approval_binding = ApprovalBindingGate()
        self._escalations: dict[tuple[str, str], EscalationRecord] = {}
        self._computer_claims: dict[str, ComputerOwnershipClaim] = {}
        self._jobs: list[TurnJob] = []
        self._messaging_store = messaging_store or InMemoryMessagingStore()
        self._turn_enqueued = turn_enqueued
        self._logical_enqueue_delivery_count = 0
        self._visibility_ledger = visibility_ledger or QueueVisibilityLedger()
        self._visibility_renewer = visibility_renewer
        self._turn_tenants: dict[str, str] = {}
        self._turn_event_subscribers: dict[str, list[queue.Queue[TurnEvent | None]]] = (
            {}
        )
        self._post_idempotency: dict[tuple[str, str], tuple[Message, str | None]] = {}
        if deadline_scheduler is not None:
            self._deadline_scheduler = deadline_scheduler
        else:
            self._deadline_scheduler = InMemoryTurnDeadlineScheduler(
                self.handle_turn_deadline
            )

    def subscribe_turn_events(self, turn_id: str) -> queue.Queue[TurnEvent | None]:
        """Register one SSE watcher and return its dedicated live-event queue."""
        subscriber = queue.Queue()
        self._turn_event_subscribers.setdefault(turn_id, []).append(subscriber)
        return subscriber

    def unsubscribe_turn_events(
        self,
        turn_id: str,
        subscriber: queue.Queue[TurnEvent | None],
    ) -> None:
        """Remove one SSE watcher and signal its collector thread to exit."""
        subscribers = self._turn_event_subscribers.get(turn_id)
        if subscribers is None:
            return
        try:
            subscribers.remove(subscriber)
        except ValueError:
            return
        if not subscribers:
            del self._turn_event_subscribers[turn_id]
        subscriber.put_nowait(None)

    @property
    def _now(self) -> datetime:
        if self._wall_clock:
            return datetime.now(UTC)
        return self._frozen_now

    @_now.setter
    def _now(self, moment: datetime) -> None:
        self._wall_clock = False
        self._frozen_now = moment

    def set_now(self, moment: datetime) -> None:
        """Pin the clock so behavior specs can expire heartbeats."""
        self._now = moment

    def advance_seconds(self, seconds: float) -> None:
        """Move the clock forward without waiting in real time."""
        self._now = self._now + timedelta(seconds=seconds)
        if isinstance(self._deadline_scheduler, InMemoryTurnDeadlineScheduler):
            self._deadline_scheduler.check_deadlines(self._now)

    def now(self) -> datetime:
        """Return the current control-plane clock."""
        return self._now

    def _fault(self, boundary: TurnBoundary, window: CrashWindow) -> None:
        if self._fault_injector is not None:
            self._fault_injector.maybe_crash(boundary, window)

    def register_worker(self, registration: WorkerRegistration) -> None:
        """Register or replace a worker and record a heartbeat.

        A ``worker_id`` is owned by the tenant that first registered it.
        Re-registering under a different tenant is rejected.

        :raises WorkerTenantMismatchError: If the worker already belongs to
            another tenant.
        """
        existing = self._workers.get(registration.worker_id)
        if (
            existing is not None
            and existing.registration.tenant_id != registration.tenant_id
        ):
            raise WorkerTenantMismatchError(
                f"Worker {registration.worker_id!r} is registered to tenant "
                f"{existing.registration.tenant_id!r}, not "
                f"{registration.tenant_id!r}."
            )
        self._workers[registration.worker_id] = WorkerRecord(
            registration=registration,
            last_heartbeat_at=self._now,
        )

    def heartbeat(self, worker_id: str) -> None:
        """
        Refresh a worker's heartbeat.

        :raises KeyError: If the worker is not registered.
        """
        record = self._workers[worker_id]
        record.last_heartbeat_at = self._now

    def worker(self, worker_id: str) -> WorkerRecord:
        """
        Return a registered worker.

        :raises KeyError: If the worker is not registered.
        """
        return self._workers[worker_id]

    def all_workers(self) -> list[WorkerRecord]:
        """Return every registered worker, including stale ones."""
        return list(self._workers.values())

    def healthy_workers(self, tenant_id: str) -> list[WorkerRecord]:
        """Return workers for a tenant whose heartbeat is still fresh."""
        healthy: list[WorkerRecord] = []
        for record in self._workers.values():
            if record.registration.tenant_id != tenant_id:
                continue
            if self._now - record.last_heartbeat_at > self.heartbeat_timeout:
                continue
            healthy.append(record)
        return healthy

    def enqueue_turn(
        self,
        tenant_id: str,
        required_capabilities: frozenset[str],
        computer_policy: ComputerPolicy | None = None,
        computer_id: str | None = None,
        *,
        user_id: str | None = None,
        bot_id: str | None = None,
    ) -> TurnJob:
        """Create a turn job. Assignment happens in ``assign_turn``.

        If ``bot_id`` is set, the job belongs to that bot's user and, unless a
        pin is supplied, is pinned to that user's computer with that
        computer's policy.
        """
        resolved_user_id = user_id
        resolved_tenant_id = tenant_id
        if bot_id is not None:
            bot = self._bots[bot_id]
            resolved_user_id = bot.user_id
            resolved_tenant_id = bot.tenant_id
        needs_computer = "computer" in required_capabilities
        resolved_computer_id = computer_id
        resolved_policy = computer_policy
        if needs_computer and resolved_user_id is not None:
            computer = self.ensure_computer(resolved_tenant_id, resolved_user_id)
            if resolved_computer_id is None:
                resolved_computer_id = computer.computer_id
            if resolved_policy is None:
                resolved_policy = computer.policy
        if resolved_policy is None:
            resolved_policy = ComputerPolicy.PREFER_LOCAL
        job = TurnJob(
            job_id=str(uuid4()),
            tenant_id=resolved_tenant_id,
            required_capabilities=required_capabilities,
            computer_policy=resolved_policy,
            computer_id=resolved_computer_id,
            user_id=resolved_user_id,
            bot_id=bot_id,
            turn_id=None,
        )
        self._jobs.append(job)
        return job

    def pending_jobs_for_bot(self, bot_id: str) -> list[TurnJob]:
        """Return turn jobs still queued for a bot."""
        return [job for job in self._jobs if job.bot_id == bot_id]

    def job_for_turn(self, tenant_id: str, turn_id: str) -> TurnJob | None:
        """Return the queued job bound to one turn, if any."""
        return self._job_for_turn(tenant_id, turn_id)

    def assign_turn(self, job: TurnJob) -> WorkerRegistration | None:
        """Choose a healthy worker for a turn, or None if none match."""
        candidates = [
            record
            for record in self.healthy_workers(job.tenant_id)
            if job.required_capabilities.issubset(record.registration.capabilities)
        ]
        if job.computer_id is not None:
            candidates = [
                record
                for record in candidates
                if record.registration.computer_id == job.computer_id
            ]
            computer = self._computers_by_id.get(job.computer_id)
            if computer is not None and computer.hydrate_required:
                if computer.intended_host_worker_id is None:
                    return None
                candidates = [
                    record
                    for record in candidates
                    if record.registration.worker_id == computer.intended_host_worker_id
                ]
        if job.computer_policy == ComputerPolicy.LOCAL_ONLY:
            candidates = [
                record
                for record in candidates
                if record.registration.cost_class == CostClass.LOCAL
            ]
        elif job.computer_policy == ComputerPolicy.AWS_ONLY:
            candidates = [
                record
                for record in candidates
                if record.registration.cost_class in AWS_COST_CLASSES
            ]
        if not candidates:
            return None
        candidates.sort(
            key=lambda record: (
                COST_CLASS_RANK[record.registration.cost_class],
                -record.last_heartbeat_at.timestamp(),
            )
        )
        return candidates[0].registration

    def create_bot(self, tenant_id: str, user_id: str, name: str) -> Bot:
        """Create a named bot and ensure the user has a computer.

        :raises DuplicateBotNameError: If the user already has this bot name.
        """
        for bot in self._bots.values():
            if (
                bot.tenant_id == tenant_id
                and bot.user_id == user_id
                and bot.name == name
            ):
                raise DuplicateBotNameError(
                    f"Bot named {name!r} already exists for user {user_id!r}."
                )
        self.ensure_computer(tenant_id, user_id)
        bot = Bot(
            bot_id=str(uuid4()),
            tenant_id=tenant_id,
            user_id=user_id,
            name=name,
        )
        self._bots[bot.bot_id] = bot
        self._messaging_store.put_bot(bot)
        return bot

    def ensure_computer(
        self,
        tenant_id: str,
        user_id: str,
        computer_id: str | None = None,
    ) -> Computer:
        """Return the user's computer, creating it if needed.

        The first call may set a stable ``computer_id`` so workers can
        advertise the same workplace.
        """
        key = (tenant_id, user_id)
        computer = self._computers_by_user.get(key)
        if computer is None:
            computer = self._messaging_store.get_computer(tenant_id, user_id)
        if computer is None:
            computer = Computer(
                computer_id=computer_id or str(uuid4()),
                tenant_id=tenant_id,
                user_id=user_id,
            )
            self._messaging_store.put_computer(computer)
        else:
            self._computers_by_id[computer.computer_id] = computer
        self._computers_by_user[key] = computer
        self._computers_by_id[computer.computer_id] = computer
        return computer

    def computer_for_user(self, tenant_id: str, user_id: str) -> Computer:
        """
        Return the existing computer for a user.

        :raises KeyError: If the user has no computer.
        """
        computer = self._computers_by_user.get((tenant_id, user_id))
        if computer is None:
            computer = self._messaging_store.get_computer(tenant_id, user_id)
            if computer is None:
                raise KeyError((tenant_id, user_id))
            self._computers_by_user[(tenant_id, user_id)] = computer
            self._computers_by_id[computer.computer_id] = computer
        return computer

    def _bot(self, tenant_id: str, bot_id: str) -> Bot:
        """Return a bot from memory or the messaging store."""
        bot = self._bots.get(bot_id)
        if bot is None:
            bot = self._messaging_store.get_bot(tenant_id, bot_id)
            if bot is None:
                raise KeyError(bot_id)
            self._bots[bot_id] = bot
        return bot

    def list_turn_events(
        self, tenant_id: str, turn_id: str, after_seq: int = 0
    ) -> list[TurnEvent]:
        """Return durable turn events after ``after_seq``."""
        self.turn(tenant_id, turn_id)
        return self._messaging_store.list_turn_events(tenant_id, turn_id, after_seq)

    def computer_by_id(self, computer_id: str) -> Computer:
        """
        Return a computer by workplace id.

        :raises KeyError: If no computer has that id.
        """
        return self._computers_by_id[computer_id]

    def snapshot_uri_for(self, computer: Computer) -> str:
        """Return the canonical object-store URI for a computer snapshot."""
        return snapshot_uri(computer.tenant_id, computer.computer_id)

    def snapshot(self, snapshot_uri: str) -> ComputerSnapshot:
        """
        Return a published snapshot.

        :raises KeyError: If nothing was published at that URI.
        """
        return self._snapshots[snapshot_uri]

    def publish_snapshot(
        self,
        computer_id: str,
        worker_id: str,
        snapshot_uri: str | None = None,
        checksum: str | None = None,
    ) -> ComputerSnapshot:
        """Copy the live disk into object storage and clear the dirty flag.

        The worker must host this computer. Production packs the live disk
        and uploads it first, then calls this with the URI and the pack's
        checksum. The in-memory kernel also copies workspace files into
        ``_snapshots`` so protocol specs can read them without a host disk.

        :raises KeyError: If the computer or worker is unknown.
        :raises WorkerDoesNotHostComputerError: If the worker is not a host
            of this workplace.
        :raises ComputerNotHydratedError: If relocate is waiting on another
            host to hydrate first.
        """
        computer = self.computer_by_id(computer_id)
        if computer.hydrate_required:
            raise ComputerNotHydratedError(
                f"Computer {computer_id!r} must be hydrated before the live "
                "disk can be published."
            )
        self._require_host(computer, worker_id)
        uri = snapshot_uri or self.snapshot_uri_for(computer)
        workspace = dict(computer.workspace)
        browser_sessions = dict(computer.browser_sessions)
        record_checksum = checksum or _disk_checksum(workspace, browser_sessions)
        record = ComputerSnapshot(
            snapshot_uri=uri,
            checksum=record_checksum,
            workspace=workspace,
            browser_sessions=browser_sessions,
            published_at=self._now,
            published_by_worker_id=worker_id,
        )
        self._snapshots[uri] = record
        computer.snapshot_uri = uri
        computer.snapshot_checksum = record_checksum
        computer.disk_dirty = False
        return record

    def relocate_computer(self, computer_id: str, target_worker_id: str) -> None:
        """Point the next run at a host. Does not copy a container.

        The target worker must already advertise this ``computer_id``. Turns
        stay pinned to that host until it hydrates. Prefer-local ranking
        resumes after hydrate.

        :raises KeyError: If the computer or worker is unknown.
        :raises SnapshotRequiredError: If nothing has been published.
        :raises ComputerDirtyError: If the live disk has unpublished writes.
        :raises WorkerDoesNotHostComputerError: If the target is not a host
            of this workplace.
        """
        computer = self.computer_by_id(computer_id)
        if computer.snapshot_uri is None:
            raise SnapshotRequiredError(
                f"Computer {computer_id!r} has no published snapshot."
            )
        if computer.disk_dirty:
            raise ComputerDirtyError(
                f"Computer {computer_id!r} has unpublished live-disk writes."
            )
        self._require_host(computer, target_worker_id)
        computer.intended_host_worker_id = target_worker_id
        computer.hydrate_required = True

    def hydrate_computer(self, computer_id: str, worker_id: str) -> None:
        """Load the published snapshot onto the intended host's live disk.

        :raises KeyError: If the computer or worker is unknown, or the
            snapshot URI is missing from object storage.
        :raises SnapshotRequiredError: If nothing has been published.
        :raises WorkerDoesNotHostComputerError: If this worker is not the
            intended host, or does not host the workplace.
        """
        computer = self.computer_by_id(computer_id)
        if computer.snapshot_uri is None:
            raise SnapshotRequiredError(
                f"Computer {computer_id!r} has no published snapshot."
            )
        self._require_host(computer, worker_id)
        if (
            computer.intended_host_worker_id is not None
            and worker_id != computer.intended_host_worker_id
        ):
            raise WorkerDoesNotHostComputerError(
                f"Worker {worker_id!r} is not the intended host "
                f"{computer.intended_host_worker_id!r} for computer "
                f"{computer_id!r}."
            )
        record = self._snapshots[computer.snapshot_uri]
        computer.workspace = dict(record.workspace)
        computer.browser_sessions = dict(record.browser_sessions)
        computer.disk_dirty = False
        computer.hydrate_required = False
        computer.intended_host_worker_id = None

    def _require_host(self, computer: Computer, worker_id: str) -> None:
        record = self._workers[worker_id]
        if record.registration.computer_id != computer.computer_id:
            raise WorkerDoesNotHostComputerError(
                f"Worker {worker_id!r} hosts "
                f"{record.registration.computer_id!r}, not "
                f"{computer.computer_id!r}."
            )

    def remember(self, bot_id: str, key: str, value: str) -> None:
        """Store a memory item on one bot."""
        self._bots[bot_id].memory[key] = value

    def memory(self, bot_id: str, key: str) -> str | None:
        """Return one bot memory item, if present."""
        return self._bots[bot_id].memory.get(key)

    def write_workspace(
        self, tenant_id: str, user_id: str, path: str, content: str
    ) -> None:
        """Write a file on the user's shared computer."""
        computer = self.computer_for_user(tenant_id, user_id)
        if computer.hydrate_required:
            raise ComputerNotHydratedError(
                f"Computer {computer.computer_id!r} must be hydrated before "
                "the live disk can be written."
            )
        computer.workspace[path] = content
        computer.disk_dirty = True

    def read_workspace(self, tenant_id: str, user_id: str, path: str) -> str | None:
        """Read a file from the user's shared computer.

        While hydrate is required, reads come from the published snapshot
        (the object every host can see), not from a host's stale overlay.
        """
        computer = self.computer_for_user(tenant_id, user_id)
        if computer.hydrate_required and computer.snapshot_uri is not None:
            return self._snapshots[computer.snapshot_uri].workspace.get(path)
        return computer.workspace.get(path)

    def save_browser_session(
        self, tenant_id: str, user_id: str, service: str, session: str
    ) -> None:
        """Persist a browser session on the user's computer."""
        computer = self.computer_for_user(tenant_id, user_id)
        if computer.hydrate_required:
            raise ComputerNotHydratedError(
                f"Computer {computer.computer_id!r} must be hydrated before "
                "the live disk can be written."
            )
        computer.browser_sessions[service] = session
        computer.disk_dirty = True

    def browser_session(self, tenant_id: str, user_id: str, service: str) -> str | None:
        """Return a saved browser session, if present.

        While hydrate is required, reads come from the published snapshot.
        """
        computer = self.computer_for_user(tenant_id, user_id)
        if computer.hydrate_required and computer.snapshot_uri is not None:
            return self._snapshots[computer.snapshot_uri].browser_sessions.get(service)
        return computer.browser_sessions.get(service)

    def add_auto_review_rule(
        self,
        kind: AutoReviewRuleKind,
        action_type: str,
        tenant_id: str,
        user_id: str | None = None,
        *,
        arguments: dict[str, str] | None = None,
        created_by: str = "human",
    ) -> None:
        """Add an auto-review rule scoped to a tenant, optionally one user.

        A bot cannot create an always-allow that loosens a consequential
        action; that attempt is recorded and discarded.
        """
        if created_by == "bot" and kind == AutoReviewRuleKind.ALWAYS_ALLOW:
            self._refused_bot_auto_review.append((tenant_id, action_type))
            return
        bindings = tuple(sorted((arguments or {}).items()))
        self._auto_review_rules.append(
            AutoReviewRule(
                kind=kind,
                action_type=action_type,
                tenant_id=tenant_id,
                user_id=user_id,
                argument_bindings=bindings,
                created_by=created_by,
            )
        )

    def refused_bot_auto_review(self) -> list[tuple[str, str]]:
        """Return always-allow attempts the kernel rejected from a bot."""
        return list(self._refused_bot_auto_review)

    @property
    def approval_binding(self) -> ApprovalBindingGate:
        """Propose, approve, and execute immutable consequential operations."""
        return self._approval_binding

    def resolve_unattended_gated_action(
        self,
        action_type: str,
        tenant_id: str,
        *,
        arguments: dict[str, str],
        channel: str,
        user_id: str | None = None,
        completion_evidence: str = "system-accepted",
    ) -> OvernightGatedResult:
        """Stop or pre-authorize a consequential action with no screen."""
        return resolve_unattended_gated_action(
            action_type=action_type,
            arguments=arguments,
            channel=channel,
            rules=self._auto_review_rules,
            tenant_id=tenant_id,
            user_id=user_id,
            completion_evidence=completion_evidence,
        )

    def attempt_authenticated_browser_action(
        self,
        action: str,
        *,
        structured_connector: bool = False,
        takeover_control: bool = False,
    ) -> OvernightGatedResult:
        """Refuse unbound consequential browser actions."""
        return resolve_unbound_authenticated_browser_action(
            action,
            structured_connector=structured_connector,
            takeover_control=takeover_control,
        )

    def prepare_computer_tool(
        self,
        tenant_id: str,
        turn_id: str,
        *,
        tool_name: str,
        arguments: dict[str, str],
    ) -> EscalationRecord:
        """Record that a computerless turn is ready to request a computer tool."""
        turn = self.turn(tenant_id, turn_id)
        bot = self._bots[turn.bot_id]
        computer = self.ensure_computer(tenant_id, bot.user_id)
        record = EscalationRecord(
            turn_id=turn_id,
            tenant_id=tenant_id,
            user_id=bot.user_id,
            computer_id=computer.computer_id,
            pending_call=PendingComputerToolCall(
                action_id=str(uuid4()),
                tool_name=tool_name,
                arguments=dict(arguments),
            ),
        )
        self._escalations[(tenant_id, turn_id)] = record
        return record

    def escalation_for(self, tenant_id: str, turn_id: str) -> EscalationRecord:
        """Return the computer-handoff record for one turn."""
        record = self._escalations.get((tenant_id, turn_id))
        if record is None:
            raise TurnNotFoundError(f"Turn {turn_id!r} has no computer handoff.")
        return record

    def commit_pending_computer_tool(self, tenant_id: str, turn_id: str) -> None:
        """Make the pending computer tool call durable."""
        record = self.escalation_for(tenant_id, turn_id)
        record.call_committed = True

    def enqueue_computer_continuation(self, tenant_id: str, turn_id: str) -> None:
        """Enqueue one computer-capable continuation for the same turn."""
        record = self.escalation_for(tenant_id, turn_id)
        if not record.call_committed:
            raise TurnTerminalError(
                f"Turn {turn_id!r} has no committed computer tool call."
            )
        if record.continuation_enqueued:
            return
        turn = self.turn(tenant_id, turn_id)
        job = self.enqueue_turn(
            tenant_id,
            frozenset({"cpu", "computer"}),
            computer_id=record.computer_id,
            user_id=record.user_id,
            bot_id=turn.bot_id,
        )
        self._bind_job_to_turn(job.job_id, turn_id)
        record.continuation_job_id = job.job_id
        record.continuation_enqueued = True

    def relinquish_computerless_ownership(self, tenant_id: str, turn_id: str) -> None:
        """Drop the computerless fence so a computer-capable attempt can claim."""
        record = self.escalation_for(tenant_id, turn_id)
        if not record.continuation_enqueued:
            raise TurnTerminalError(
                f"Turn {turn_id!r} has not enqueued a computer continuation."
            )
        turn = self.turn(tenant_id, turn_id)
        turn.claimed_by_worker_id = None
        turn.attempt_id = None
        turn.lease_expires_at = None
        turn.fence_token += 1
        self._messaging_store.put_turn(turn)
        record.computerless_relinquished = True

    def claim_computer_for_turn(
        self,
        tenant_id: str,
        turn_id: str,
        worker_id: str,
    ) -> bool:
        """Take an exclusive computer lease for the fenced turn owner."""
        self.expire_orphaned_computer_claims()
        record = self.escalation_for(tenant_id, turn_id)
        turn = self.turn(tenant_id, turn_id)
        if turn.claimed_by_worker_id != worker_id:
            return False
        existing = self._computer_claims.get(record.computer_id)
        if (
            existing is not None
            and existing.expires_at > self._now
            and existing.turn_id != turn_id
        ):
            return False
        if (
            existing is not None
            and existing.expires_at > self._now
            and existing.attempt_id != turn.attempt_id
            and existing.turn_id == turn_id
        ):
            return False
        self._computer_claims[record.computer_id] = ComputerOwnershipClaim(
            computer_id=record.computer_id,
            turn_id=turn_id,
            attempt_id=turn.attempt_id or worker_id,
            worker_id=worker_id,
            expires_at=self._now + self.attempt_lease,
        )
        return True

    def execute_pending_computer_action(self, tenant_id: str, turn_id: str) -> None:
        """Run the pending computer tool at most once."""
        record = self.escalation_for(tenant_id, turn_id)
        claim = self._computer_claims.get(record.computer_id)
        if claim is None or claim.turn_id != turn_id or claim.expires_at <= self._now:
            raise TurnTerminalError(f"Turn {turn_id!r} does not hold the computer.")
        if record.computer_action_count:
            return
        record.computer_action_count += 1

    def commit_computer_tool_result(
        self,
        tenant_id: str,
        turn_id: str,
        result_body: str,
    ) -> None:
        """Commit the computer tool result without repeating the action."""
        record = self.escalation_for(tenant_id, turn_id)
        if record.computer_action_count != 1:
            raise TurnTerminalError(
                f"Turn {turn_id!r} has no computer action to commit."
            )
        record.result_body = result_body
        record.result_committed = True

    def recover_computer_escalation(self, tenant_id: str, turn_id: str) -> None:
        """Continue a crashed handoff exactly once, then complete the turn."""
        record = self.escalation_for(tenant_id, turn_id)
        if not record.call_committed:
            self.commit_pending_computer_tool(tenant_id, turn_id)
        if not record.continuation_enqueued:
            self.enqueue_computer_continuation(tenant_id, turn_id)
        if not record.computerless_relinquished:
            self.relinquish_computerless_ownership(tenant_id, turn_id)
        claimed = self.claim_turn_attempt(tenant_id, turn_id, "computer-worker")
        if claimed is None:
            raise TurnTerminalError(
                f"Turn {turn_id!r} could not be claimed for computer continuation."
            )
        if not self.claim_computer_for_turn(tenant_id, turn_id, "computer-worker"):
            raise TurnTerminalError(f"Turn {turn_id!r} could not claim the computer.")
        if record.computer_action_count == 0:
            self.execute_pending_computer_action(tenant_id, turn_id)
        if not record.result_committed:
            self.commit_computer_tool_result(
                tenant_id, turn_id, record.result_body or "opened"
            )
        turn = self.turn(tenant_id, turn_id)
        self._complete_turn(turn, expected_fence=turn.fence_token)

    def active_computer_controllers(self, computer_id: str) -> list[str]:
        """Return attempt ids that currently hold an unexpired computer lease."""
        self.expire_orphaned_computer_claims()
        claim = self._computer_claims.get(computer_id)
        if claim is None:
            return []
        return [claim.attempt_id]

    def expire_orphaned_computer_claims(self) -> None:
        """Drop computer leases whose deadline has passed."""
        expired = [
            computer_id
            for computer_id, claim in self._computer_claims.items()
            if claim.expires_at <= self._now
        ]
        for computer_id in expired:
            del self._computer_claims[computer_id]

    def evaluate_action(
        self,
        action_type: str,
        tenant_id: str,
        user_id: str | None = None,
    ) -> ApprovalDecision:
        """Evaluate a proposed action against defaults and tenant rules."""
        matching = [
            rule
            for rule in self._auto_review_rules
            if rule.action_type == action_type
            and rule.tenant_id == tenant_id
            and (rule.user_id is None or rule.user_id == user_id)
        ]
        if any(rule.kind == AutoReviewRuleKind.NEVER_ALLOW for rule in matching):
            return ApprovalDecision.DENY
        if any(rule.kind == AutoReviewRuleKind.REQUIRE_APPROVAL for rule in matching):
            return ApprovalDecision.REQUIRE_APPROVAL
        if any(rule.kind == AutoReviewRuleKind.ALWAYS_ALLOW for rule in matching):
            return ApprovalDecision.ALLOW
        if action_type in CONSEQUENTIAL_ACTION_TYPES:
            return ApprovalDecision.REQUIRE_APPROVAL
        return ApprovalDecision.ALLOW

    def remove_pending_job(self, job_id: str) -> None:
        """Drop a turn job after a worker finishes it."""
        self._fault(TurnBoundary.ACKNOWLEDGEMENT, CrashWindow.BEFORE)
        self._jobs = [job for job in self._jobs if job.job_id != job_id]
        self._fault(TurnBoundary.ACKNOWLEDGEMENT, CrashWindow.AFTER)

    def set_computer_stopped(self, tenant_id: str, user_id: str, stopped: bool) -> None:
        """Mark the household computer stopped without deleting it."""
        computer = self.ensure_computer(tenant_id, user_id)
        computer.stopped = stopped
        self._messaging_store.put_computer(computer)

    def computer_is_stopped(self, tenant_id: str, user_id: str) -> bool:
        """Return whether the household computer is stopped."""
        return self.computer_for_user(tenant_id, user_id).stopped

    def create_channel(
        self,
        tenant_id: str,
        user_id: str,
        bot_ids: list[str] | None = None,
    ) -> Channel:
        """Open a channel for a user and the given bots.

        The human is always a participant. Each bot must belong to the same
        tenant and user.

        :raises KeyError: If a bot id is unknown.
        :raises ActorNotInChannelError: If a bot belongs to another user.
        """
        participants = [ChannelParticipant(kind=ActorKind.HUMAN, actor_id=user_id)]
        for bot_id in bot_ids or []:
            bot = self._bot(tenant_id, bot_id)
            if bot.tenant_id != tenant_id or bot.user_id != user_id:
                raise ActorNotInChannelError(
                    f"Bot {bot_id!r} does not belong to tenant {tenant_id!r} "
                    f"user {user_id!r}."
                )
            participants.append(ChannelParticipant(kind=ActorKind.BOT, actor_id=bot_id))
        channel = Channel(
            channel_id=str(uuid4()),
            tenant_id=tenant_id,
            user_id=user_id,
            participants=participants,
        )
        self._messaging_store.put_channel(channel)
        return channel

    def channel(self, tenant_id: str, channel_id: str) -> Channel:
        """
        Return a channel.

        :raises ChannelNotFoundError: If the channel is unknown.
        """
        record = self._messaging_store.get_channel(tenant_id, channel_id)
        if record is None:
            raise ChannelNotFoundError(f"Channel {channel_id!r} does not exist.")
        return record

    def post_channel_message(
        self,
        channel_id: str,
        tenant_id: str,
        author_kind: ActorKind,
        author_id: str,
        body: str,
        addressed_to_bot_id: str | None = None,
        *,
        enqueue_turn: bool = True,
        idempotency_key: str | None = None,
    ) -> tuple[Message, Turn | None]:
        """Append a committed message and enqueue a cpu turn when addressed.

        :raises ChannelNotFoundError: If the channel is unknown.
        :raises ChannelTenantMismatchError: If the tenant does not own the
            channel.
        :raises ActorNotInChannelError: If the author or addressee is not a
            participant.
        """
        if idempotency_key is not None:
            cached = self._post_idempotency.get((tenant_id, idempotency_key))
            if cached is not None:
                message, turn_id = cached
                started = self.turn(tenant_id, turn_id) if turn_id is not None else None
                return message, started
        channel = self._require_channel_tenant(channel_id, tenant_id)
        self._require_participant(channel, author_kind, author_id)
        if addressed_to_bot_id is not None:
            self._require_participant(channel, ActorKind.BOT, addressed_to_bot_id)
        message = Message(
            message_id=str(uuid4()),
            channel_id=channel.channel_id,
            tenant_id=channel.tenant_id,
            seq=channel.next_seq,
            author_kind=author_kind,
            author_id=author_id,
            body=body,
            addressed_to_bot_id=addressed_to_bot_id,
            created_at=self._now,
        )
        channel.next_seq += 1
        self._messaging_store.put_channel(channel)
        self._fault(TurnBoundary.MESSAGE_COMMIT, CrashWindow.BEFORE)
        self._messaging_store.put_message(message)
        self._fault(TurnBoundary.MESSAGE_COMMIT, CrashWindow.AFTER)
        started: Turn | None = None
        if enqueue_turn and addressed_to_bot_id is not None:
            started = self._start_turn_for_bot(channel, addressed_to_bot_id)
        if idempotency_key is not None:
            turn_id = started.turn_id if started is not None else None
            self._post_idempotency[(tenant_id, idempotency_key)] = (message, turn_id)
        return message, started

    def list_channel_messages(
        self,
        channel_id: str,
        tenant_id: str,
        after_seq: int = 0,
    ) -> list[Message]:
        """Return committed messages with seq greater than ``after_seq``.

        :raises ChannelNotFoundError: If the channel is unknown.
        :raises ChannelTenantMismatchError: If the tenant does not own the
            channel.
        """
        channel = self._require_channel_tenant(channel_id, tenant_id)
        return self._messaging_store.list_messages(
            channel.tenant_id, channel.channel_id, after_seq
        )

    def turn(self, tenant_id: str, turn_id: str) -> Turn:
        """
        Return one turn.

        :raises TurnNotFoundError: If the turn is unknown.
        """
        record = self._messaging_store.get_turn(tenant_id, turn_id)
        if record is None:
            raise TurnNotFoundError(f"Turn {turn_id!r} does not exist.")
        return record

    def claim_turn_attempt(
        self,
        tenant_id: str,
        turn_id: str,
        worker_id: str,
    ) -> TurnAttempt | None:
        """Conditionally become the fenced owner of an active turn.

        A worker that already holds the unexpired lease gets the attempt
        with ``acquired=False`` and must not start another model call.
        """
        self.turn(tenant_id, turn_id)
        self._fault(TurnBoundary.WORKER_CLAIM, CrashWindow.BEFORE)
        claimed = self._messaging_store.claim_turn_attempt(
            tenant_id,
            turn_id,
            worker_id,
            str(uuid4()),
            self._now,
            self._now + self.attempt_lease,
        )
        if claimed is None:
            return None
        turn, acquired = claimed
        if turn.attempt_id is None:
            return None
        if self.recovery_enabled and acquired:
            turn.deadline_at = self._now + self.turn_deadline
            self._messaging_store.put_turn(turn)
            self._deadline_scheduler.schedule(tenant_id, turn_id, turn.deadline_at)
        if acquired:
            self._fault(TurnBoundary.WORKER_CLAIM, CrashWindow.AFTER)
        return TurnAttempt(
            tenant_id=turn.tenant_id,
            turn_id=turn.turn_id,
            attempt_id=turn.attempt_id,
            fence_token=turn.fence_token,
            worker_id=worker_id,
            acquired=acquired,
            lease_expires_at=turn.lease_expires_at or (self._now + self.attempt_lease),
        )

    def renew_turn_lease(
        self,
        tenant_id: str,
        turn_id: str,
        worker_id: str,
        fence_token: int,
        *,
        job: TurnJob | None = None,
    ) -> TurnAttempt | None:
        """Extend the lease if this worker still holds the fence."""
        renewed = self._messaging_store.renew_turn_lease(
            tenant_id,
            turn_id,
            worker_id,
            fence_token,
            self._now + self.attempt_lease,
        )
        if renewed is None or renewed.attempt_id is None:
            return None
        if self.recovery_enabled:
            renewed.deadline_at = self._now + self.turn_deadline
            self._messaging_store.put_turn(renewed, expected_fence=fence_token)
            self._deadline_scheduler.schedule(tenant_id, turn_id, renewed.deadline_at)
        if job is not None:
            self._renew_queue_visibility(job)
        return TurnAttempt(
            tenant_id=renewed.tenant_id,
            turn_id=renewed.turn_id,
            attempt_id=renewed.attempt_id,
            fence_token=renewed.fence_token,
            worker_id=worker_id,
            acquired=False,
            lease_expires_at=renewed.lease_expires_at
            or (self._now + self.attempt_lease),
        )

    def request_logical_enqueue(
        self,
        tenant_id: str,
        turn_id: str,
        enqueue_id: str,
        job: TurnJob,
    ) -> bool:
        """Enqueue a turn job once per ``enqueue_id``."""
        self._fault(TurnBoundary.LOGICAL_ENQUEUE, CrashWindow.BEFORE)
        if not self._messaging_store.record_logical_enqueue(
            tenant_id, turn_id, enqueue_id
        ):
            return False
        self._logical_enqueue_delivery_count += 1
        self._fault(TurnBoundary.LOGICAL_ENQUEUE, CrashWindow.AFTER)
        if self._turn_enqueued is not None:
            self._turn_enqueued(job)
        return True

    def handle_turn_deadline(self, tenant_id: str, turn_id: str) -> None:
        """Recover or fail a turn when its watchdog fires."""
        turn = self._messaging_store.get_turn(tenant_id, turn_id)
        if turn is None or turn.status != TurnStatus.ACTIVE:
            return
        lease_valid = (
            turn.lease_expires_at is not None and turn.lease_expires_at > self._now
        )
        if lease_valid:
            if turn.deadline_at is not None:
                self._deadline_scheduler.schedule(tenant_id, turn_id, turn.deadline_at)
            return
        if turn.ambiguous_provider_call_id is not None:
            self._mark_turn_reconciling(turn, "provider outcome unknown")
            return
        if turn.recovery_attempts >= self.max_recovery_attempts:
            self._fail_turn(turn, "recovery attempts exhausted")
            return
        self._fault(TurnBoundary.DEADLINE_RECOVERY, CrashWindow.BEFORE)
        turn.recovery_attempts += 1
        turn.attempt_id = None
        turn.claimed_by_worker_id = None
        turn.lease_expires_at = None
        turn.fence_token += 1
        turn.deadline_at = self._now + self.turn_deadline
        self._messaging_store.put_turn(turn)
        self._fault(TurnBoundary.DEADLINE_RECOVERY, CrashWindow.AFTER)
        self._deadline_scheduler.schedule(tenant_id, turn_id, turn.deadline_at)
        job = self._job_for_turn(tenant_id, turn_id)
        if job is not None:
            self.request_logical_enqueue(
                tenant_id,
                turn_id,
                logical_enqueue_id(turn_id, recovery_attempt=turn.recovery_attempts),
                job,
            )

    def record_ambiguous_provider_outcome(
        self,
        tenant_id: str,
        turn_id: str,
        provider_call_id: str,
    ) -> Turn:
        """Mark a turn as needing reconciliation before consequential work."""
        turn = self.turn(tenant_id, turn_id)
        if turn.status != TurnStatus.ACTIVE:
            raise TurnTerminalError(f"Turn {turn_id!r} is not active.")
        turn.ambiguous_provider_call_id = provider_call_id
        self._messaging_store.put_turn(turn)
        return turn

    def attempt_consequential_action(
        self,
        tenant_id: str,
        turn_id: str,
        action_type: str,
        user_id: str | None = None,
    ) -> ApprovalDecision:
        """Evaluate an action, blocking repeats while reconciliation is pending."""
        turn = self.turn(tenant_id, turn_id)
        if turn.status == TurnStatus.RECONCILING:
            raise TurnReconcilingError(
                f"Turn {turn_id!r} is reconciling provider call "
                f"{turn.ambiguous_provider_call_id!r}."
            )
        return self.evaluate_action(action_type, tenant_id, user_id)

    @property
    def logical_enqueue_delivery_count(self) -> int:
        """Return how many distinct logical enqueues were delivered."""
        return self._logical_enqueue_delivery_count

    @property
    def queue_visibility_renewals(self) -> list[tuple[str, str]]:
        """Return queue visibility renewals recorded for behavior specs."""
        return list(self._visibility_ledger.renewals)

    def active_turn_for_channel(self, tenant_id: str, channel_id: str) -> Turn | None:
        """Return the active turn on a channel, if any."""
        messages = self._messaging_store.list_messages(tenant_id, channel_id)
        for message in reversed(messages):
            if message.addressed_to_bot_id is None:
                continue
            for job in self.pending_jobs_for_bot(message.addressed_to_bot_id):
                if job.turn_id is not None:
                    turn = self._messaging_store.get_turn(tenant_id, job.turn_id)
                    if (
                        turn is not None
                        and turn.channel_id == channel_id
                        and turn.status == TurnStatus.ACTIVE
                    ):
                        return turn
        return None

    def turn_prompt(self, tenant_id: str, turn_id: str) -> str:
        """Build a text-only prompt from channel messages for the model loop."""
        turn = self.turn(tenant_id, turn_id)
        messages = self._messaging_store.list_messages(tenant_id, turn.channel_id)
        lines = [f"{message.author_kind}: {message.body}" for message in messages]
        return "\n".join(lines)

    def post_turn_chunk(
        self,
        turn_id: str,
        tenant_id: str,
        token: str,
        *,
        complete: bool = False,
        fence_token: int,
    ) -> None:
        """Append one coalesced chunk and optionally complete the turn.

        :raises TurnNotFoundError: If the turn is unknown.
        :raises StaleAttemptError: If the fence does not match the owner.
        """
        turn = self.turn(tenant_id, turn_id)
        if turn.fence_token != fence_token:
            raise StaleAttemptError(
                f"Turn {turn_id!r} rejected fence {fence_token} "
                f"(current {turn.fence_token})."
            )
        if turn.status != TurnStatus.ACTIVE:
            return
        expires_at = default_chunk_expiry(self._now)
        if not complete:
            self._fault(TurnBoundary.PROGRESS_APPEND, CrashWindow.BEFORE)
        appended = self._messaging_store.put_turn_chunk(
            tenant_id,
            turn_id,
            turn.next_chunk_seq,
            token,
            expires_at,
        )
        if not appended:
            if complete:
                self._complete_turn(turn, expected_fence=fence_token)
            return
        turn.next_chunk_seq += 1
        self._messaging_store.put_turn(turn, expected_fence=fence_token)
        if not complete:
            self._fault(TurnBoundary.PROGRESS_APPEND, CrashWindow.AFTER)
        self._append_turn_event(
            turn,
            TurnEventKind.TURN_TOKEN,
            token=token,
            expected_fence=fence_token,
        )
        if complete:
            self._complete_turn(turn, expected_fence=fence_token)

    def complete_turn(
        self, tenant_id: str, turn_id: str, *, fence_token: int
    ) -> Message:
        """Join chunks into one committed message row.

        :raises TurnNotFoundError: If the turn is unknown.
        :raises StaleAttemptError: If the fence does not match the owner.
        """
        turn = self.turn(tenant_id, turn_id)
        if turn.fence_token != fence_token:
            raise StaleAttemptError(
                f"Turn {turn_id!r} rejected fence {fence_token} "
                f"(current {turn.fence_token})."
            )
        return self._complete_turn(turn, expected_fence=fence_token)

    def _start_turn_for_bot(self, channel: Channel, bot_id: str) -> Turn:
        turn = Turn(
            turn_id=str(uuid4()),
            tenant_id=channel.tenant_id,
            channel_id=channel.channel_id,
            bot_id=bot_id,
        )
        if self.recovery_enabled:
            turn.deadline_at = self._now + self.turn_deadline
        self._messaging_store.put_turn(turn)
        self._turn_tenants[turn.turn_id] = channel.tenant_id
        self._append_turn_event(turn, TurnEventKind.TURN_STARTED)
        job = self.enqueue_turn(
            channel.tenant_id,
            frozenset({"cpu"}),
            bot_id=bot_id,
        )
        self._bind_job_to_turn(job.job_id, turn.turn_id)
        if self.recovery_enabled and turn.deadline_at is not None:
            self._deadline_scheduler.schedule(
                channel.tenant_id, turn.turn_id, turn.deadline_at
            )
        return turn

    def _bind_job_to_turn(self, job_id: str, turn_id: str) -> None:
        for index, job in enumerate(self._jobs):
            if job.job_id == job_id:
                bound = TurnJob(
                    job_id=job.job_id,
                    tenant_id=job.tenant_id,
                    required_capabilities=job.required_capabilities,
                    computer_policy=job.computer_policy,
                    computer_id=job.computer_id,
                    user_id=job.user_id,
                    bot_id=job.bot_id,
                    turn_id=turn_id,
                )
                self._jobs[index] = bound
                if self.recovery_enabled:
                    self.request_logical_enqueue(
                        bound.tenant_id,
                        turn_id,
                        logical_enqueue_id(turn_id),
                        bound,
                    )
                elif self._turn_enqueued is not None:
                    self._turn_enqueued(bound)
                return

    def _complete_turn(
        self, turn: Turn, *, expected_fence: int | None = None
    ) -> Message:
        if turn.status == TurnStatus.COMPLETED:
            chunks = self._messaging_store.list_turn_chunks(
                turn.tenant_id, turn.turn_id
            )
            messages = self._messaging_store.list_messages(
                turn.tenant_id, turn.channel_id
            )
            for message in reversed(messages):
                if (
                    message.author_kind == ActorKind.BOT
                    and message.author_id == turn.bot_id
                ):
                    return message
            body = "".join(chunks)
            return Message(
                message_id=str(uuid4()),
                channel_id=turn.channel_id,
                tenant_id=turn.tenant_id,
                seq=0,
                author_kind=ActorKind.BOT,
                author_id=turn.bot_id,
                body=body,
                addressed_to_bot_id=None,
                created_at=self._now,
            )
        messages = self._messaging_store.list_messages(turn.tenant_id, turn.channel_id)
        for message in reversed(messages):
            if (
                message.author_kind == ActorKind.BOT
                and message.author_id == turn.bot_id
            ):
                return self._finalize_committed_turn(
                    turn,
                    message,
                    body=message.body,
                    expected_fence=expected_fence,
                )
        chunks = self._messaging_store.list_turn_chunks(turn.tenant_id, turn.turn_id)
        body = "".join(chunks)
        channel = self.channel(turn.tenant_id, turn.channel_id)
        self._fault(TurnBoundary.COMPLETION_APPEND, CrashWindow.BEFORE)
        message = Message(
            message_id=str(uuid4()),
            channel_id=channel.channel_id,
            tenant_id=channel.tenant_id,
            seq=channel.next_seq,
            author_kind=ActorKind.BOT,
            author_id=turn.bot_id,
            body=body,
            addressed_to_bot_id=None,
            created_at=self._now,
        )
        channel.next_seq += 1
        self._messaging_store.put_channel(channel)
        self._messaging_store.put_message(message)
        self._fault(TurnBoundary.COMPLETION_APPEND, CrashWindow.AFTER)
        return self._finalize_committed_turn(
            turn,
            message,
            body=body,
            expected_fence=expected_fence,
        )

    def _finalize_committed_turn(
        self,
        turn: Turn,
        message: Message,
        *,
        body: str,
        expected_fence: int | None = None,
    ) -> Message:
        turn.status = TurnStatus.COMPLETED
        self._messaging_store.put_turn(turn, expected_fence=expected_fence)
        self._deadline_scheduler.cancel(turn.tenant_id, turn.turn_id)
        self._append_turn_event(
            turn,
            TurnEventKind.TURN_COMPLETED,
            message_seq=message.seq,
            body=body,
            expected_fence=expected_fence,
        )
        self._signal_turn_subscribers(turn.turn_id, None)
        return message

    def _append_turn_event(
        self,
        turn: Turn,
        kind: TurnEventKind,
        *,
        token: str | None = None,
        message_seq: int | None = None,
        body: str | None = None,
        expected_fence: int | None = None,
    ) -> TurnEvent:
        event = TurnEvent(
            event_id=str(uuid4()),
            tenant_id=turn.tenant_id,
            turn_id=turn.turn_id,
            channel_id=turn.channel_id,
            seq=turn.next_event_seq,
            kind=kind,
            token=token,
            message_seq=message_seq,
            body=body,
        )
        turn.next_event_seq += 1
        self._messaging_store.put_turn(turn, expected_fence=expected_fence)
        self._messaging_store.put_turn_event(event)
        self._fan_out_turn_event(turn.turn_id, event)
        return event

    def _fan_out_turn_event(
        self,
        turn_id: str,
        event: TurnEvent | None,
    ) -> None:
        """Deliver one live turn event to every open SSE subscriber."""
        for subscriber in self._turn_event_subscribers.get(turn_id, ()):
            subscriber.put(event)

    def _signal_turn_subscribers(
        self,
        turn_id: str,
        sentinel: TurnEvent | None,
    ) -> None:
        """Broadcast a sentinel so every SSE collector can exit."""
        for subscriber in self._turn_event_subscribers.get(turn_id, ()):
            subscriber.put(sentinel)

    def _require_channel_tenant(self, channel_id: str, tenant_id: str) -> Channel:
        channel = self._messaging_store.get_channel(tenant_id, channel_id)
        if channel is not None:
            return channel
        owning_tenant = self._messaging_store.resolve_channel_tenant(channel_id)
        if owning_tenant is not None and owning_tenant != tenant_id:
            raise ChannelTenantMismatchError(
                f"Tenant {tenant_id!r} does not own channel {channel_id!r}."
            )
        raise ChannelNotFoundError(f"Channel {channel_id!r} does not exist.")

    def _require_participant(
        self,
        channel: Channel,
        kind: ActorKind,
        actor_id: str,
    ) -> None:
        for participant in channel.participants:
            if participant.kind == kind and participant.actor_id == actor_id:
                return
        raise ActorNotInChannelError(
            f"{kind} {actor_id!r} is not a participant of channel "
            f"{channel.channel_id!r}."
        )

    def _job_for_turn(self, tenant_id: str, turn_id: str) -> TurnJob | None:
        for job in self._jobs:
            if job.tenant_id == tenant_id and job.turn_id == turn_id:
                return job
        return None

    def _renew_queue_visibility(self, job: TurnJob) -> None:
        if job.turn_id is None:
            return
        self._visibility_ledger.renew(job.tenant_id, job.turn_id)
        if self._visibility_renewer is not None:
            self._visibility_renewer(job)

    def _fail_turn(self, turn: Turn, reason: str) -> None:
        turn.status = TurnStatus.FAILED
        turn.terminal_reason = reason
        self._messaging_store.put_turn(turn)
        self._deadline_scheduler.cancel(turn.tenant_id, turn.turn_id)
        self._append_turn_event(
            turn,
            TurnEventKind.TURN_FAILED,
            body=reason,
        )
        self._signal_turn_subscribers(turn.turn_id, None)

    def _mark_turn_reconciling(self, turn: Turn, reason: str) -> None:
        turn.status = TurnStatus.RECONCILING
        turn.terminal_reason = reason
        self._messaging_store.put_turn(turn)
        self._deadline_scheduler.cancel(turn.tenant_id, turn.turn_id)
        self._append_turn_event(
            turn,
            TurnEventKind.TURN_RECONCILING,
            body=reason,
        )
        self._signal_turn_subscribers(turn.turn_id, None)


def _disk_checksum(workspace: dict[str, str], browser_sessions: dict[str, str]) -> str:
    payload = json.dumps(
        {"workspace": workspace, "browser_sessions": browser_sessions},
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode()).hexdigest()
