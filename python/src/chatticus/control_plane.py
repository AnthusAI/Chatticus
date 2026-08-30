"""In-memory control plane: workers, routing, roster, approvals, messages."""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from chatticus.models import (
    AWS_COST_CLASSES,
    CONSEQUENTIAL_ACTION_TYPES,
    COST_CLASS_RANK,
    ActorKind,
    ActorNotInThreadError,
    ApprovalDecision,
    AutoReviewRule,
    AutoReviewRuleKind,
    Bot,
    Computer,
    ComputerDirtyError,
    ComputerNotHydratedError,
    ComputerPolicy,
    ComputerSnapshot,
    CostClass,
    DuplicateBotNameError,
    Message,
    RealtimeEvent,
    RealtimeEventKind,
    RealtimeSubscription,
    SnapshotRequiredError,
    Thread,
    ThreadNotFoundError,
    ThreadParticipant,
    ThreadTenantMismatchError,
    TurnJob,
    TurnStream,
    TurnStreamNotFoundError,
    WorkerDoesNotHostComputerError,
    WorkerRecord,
    WorkerRegistration,
    WorkerTenantMismatchError,
)
from chatticus.snapshot.uri import snapshot_uri


class ControlPlane:
    """Tenant-aware control plane used by the product behavior specs.

    This is the protocol kernel. HTTP, the realtime API, SQS, and the
    computer image sit on top of the same rules.
    """

    def __init__(self, heartbeat_timeout: timedelta | None = None) -> None:
        """
        :param heartbeat_timeout: Stale workers are ignored after this interval.
        :type heartbeat_timeout: timedelta | None
        """
        self.heartbeat_timeout = heartbeat_timeout or timedelta(seconds=30)
        self._now = datetime.now(UTC)
        self._workers: dict[str, WorkerRecord] = {}
        self._bots: dict[str, Bot] = {}
        self._computers_by_user: dict[tuple[str, str], Computer] = {}
        self._computers_by_id: dict[str, Computer] = {}
        self._snapshots: dict[str, ComputerSnapshot] = {}
        self._auto_review_rules: list[AutoReviewRule] = []
        self._jobs: list[TurnJob] = []
        self._threads: dict[str, Thread] = {}
        self._messages: dict[str, list[Message]] = {}
        self._subscriptions: dict[str, RealtimeSubscription] = {}
        self._streams: dict[str, TurnStream] = {}

    def set_now(self, moment: datetime) -> None:
        """Pin the clock so behavior specs can expire heartbeats."""
        self._now = moment

    def advance_seconds(self, seconds: float) -> None:
        """Move the clock forward without waiting in real time."""
        self._now = self._now + timedelta(seconds=seconds)

    def now(self) -> datetime:
        """Return the current control-plane clock."""
        return self._now

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
        resolved_computer_id = computer_id
        resolved_policy = computer_policy
        if resolved_user_id is not None:
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
        )
        self._jobs.append(job)
        return job

    def pending_jobs_for_bot(self, bot_id: str) -> list[TurnJob]:
        """Return turn jobs still queued for a bot."""
        return [job for job in self._jobs if job.bot_id == bot_id]

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
            computer = Computer(
                computer_id=computer_id or str(uuid4()),
                tenant_id=tenant_id,
                user_id=user_id,
            )
            self._computers_by_user[key] = computer
            self._computers_by_id[computer.computer_id] = computer
        return computer

    def computer_for_user(self, tenant_id: str, user_id: str) -> Computer:
        """
        Return the existing computer for a user.

        :raises KeyError: If the user has no computer.
        """
        return self._computers_by_user[(tenant_id, user_id)]

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
    ) -> None:
        """Add an auto-review rule scoped to a tenant, optionally one user."""
        self._auto_review_rules.append(
            AutoReviewRule(
                kind=kind,
                action_type=action_type,
                tenant_id=tenant_id,
                user_id=user_id,
            )
        )

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

    def create_thread(
        self,
        tenant_id: str,
        user_id: str,
        bot_ids: list[str] | None = None,
    ) -> Thread:
        """Open a thread for a user and the given bots.

        The human is always a participant. Each bot must belong to the same
        tenant and user.

        :raises KeyError: If a bot id is unknown.
        :raises ActorNotInThreadError: If a bot belongs to another user.
        """
        participants = [ThreadParticipant(kind=ActorKind.HUMAN, actor_id=user_id)]
        for bot_id in bot_ids or []:
            bot = self._bots[bot_id]
            if bot.tenant_id != tenant_id or bot.user_id != user_id:
                raise ActorNotInThreadError(
                    f"Bot {bot_id!r} does not belong to tenant {tenant_id!r} "
                    f"user {user_id!r}."
                )
            participants.append(ThreadParticipant(kind=ActorKind.BOT, actor_id=bot_id))
        thread = Thread(
            thread_id=str(uuid4()),
            tenant_id=tenant_id,
            user_id=user_id,
            participants=participants,
        )
        self._threads[thread.thread_id] = thread
        self._messages[thread.thread_id] = []
        return thread

    def thread(self, thread_id: str) -> Thread:
        """
        Return a thread.

        :raises ThreadNotFoundError: If the thread is unknown.
        """
        thread = self._threads.get(thread_id)
        if thread is None:
            raise ThreadNotFoundError(f"Thread {thread_id!r} does not exist.")
        return thread

    def post_message(
        self,
        thread_id: str,
        tenant_id: str,
        author_kind: ActorKind,
        author_id: str,
        body: str,
        addressed_to_bot_id: str | None = None,
        *,
        enqueue_turn: bool = True,
    ) -> Message:
        """Append a committed message and fan it out on the realtime API.

        Addressing a bot enqueues a turn for that bot. Streaming tokens must
        not call this until the turn is complete.

        :raises ThreadNotFoundError: If the thread is unknown.
        :raises ThreadTenantMismatchError: If the tenant does not own the
            thread.
        :raises ActorNotInThreadError: If the author or addressee is not a
            participant.
        """
        thread = self._require_thread_tenant(thread_id, tenant_id)
        self._require_participant(thread, author_kind, author_id)
        if addressed_to_bot_id is not None:
            self._require_participant(thread, ActorKind.BOT, addressed_to_bot_id)
        message = Message(
            message_id=str(uuid4()),
            thread_id=thread.thread_id,
            tenant_id=thread.tenant_id,
            seq=thread.next_seq,
            author_kind=author_kind,
            author_id=author_id,
            body=body,
            addressed_to_bot_id=addressed_to_bot_id,
            created_at=self._now,
        )
        thread.next_seq += 1
        self._messages[thread.thread_id].append(message)
        self._fanout(
            RealtimeEvent(
                event_id=str(uuid4()),
                tenant_id=thread.tenant_id,
                thread_id=thread.thread_id,
                kind=RealtimeEventKind.THREAD_MESSAGE_CREATED,
                message_seq=message.seq,
                message_id=message.message_id,
                bot_id=addressed_to_bot_id,
                body=body,
            )
        )
        if enqueue_turn and addressed_to_bot_id is not None:
            self.enqueue_turn(
                thread.tenant_id,
                frozenset({"computer"}),
                bot_id=addressed_to_bot_id,
            )
        return message

    def list_messages(
        self,
        thread_id: str,
        tenant_id: str,
        after_seq: int = 0,
    ) -> list[Message]:
        """Return committed messages with seq greater than ``after_seq``.

        This is the reconnect path for the realtime API. In-flight tokens are
        not in this list.

        :raises ThreadNotFoundError: If the thread is unknown.
        :raises ThreadTenantMismatchError: If the tenant does not own the
            thread.
        """
        thread = self._require_thread_tenant(thread_id, tenant_id)
        return [
            message
            for message in self._messages[thread.thread_id]
            if message.seq > after_seq
        ]

    def subscribe_realtime(
        self,
        thread_id: str,
        tenant_id: str,
    ) -> RealtimeSubscription:
        """Subscribe a chattic.us session to the thread's realtime API.

        :raises ThreadNotFoundError: If the thread is unknown.
        :raises ThreadTenantMismatchError: If the tenant does not own the
            thread.
        """
        thread = self._require_thread_tenant(thread_id, tenant_id)
        subscription = RealtimeSubscription(
            subscription_id=str(uuid4()),
            tenant_id=thread.tenant_id,
            thread_id=thread.thread_id,
        )
        self._subscriptions[subscription.subscription_id] = subscription
        return subscription

    def subscription(self, subscription_id: str) -> RealtimeSubscription:
        """
        Return a realtime API subscription.

        :raises KeyError: If the subscription is unknown.
        """
        return self._subscriptions[subscription_id]

    def start_turn_stream(self, thread_id: str, tenant_id: str, bot_id: str) -> str:
        """Open an in-flight token stream for a bot turn.

        :raises ThreadNotFoundError: If the thread is unknown.
        :raises ThreadTenantMismatchError: If the tenant does not own the
            thread.
        :raises ActorNotInThreadError: If the bot is not a participant.
        """
        thread = self._require_thread_tenant(thread_id, tenant_id)
        self._require_participant(thread, ActorKind.BOT, bot_id)
        stream = TurnStream(
            stream_id=str(uuid4()),
            thread_id=thread.thread_id,
            tenant_id=thread.tenant_id,
            bot_id=bot_id,
        )
        self._streams[stream.stream_id] = stream
        self._fanout(
            RealtimeEvent(
                event_id=str(uuid4()),
                tenant_id=thread.tenant_id,
                thread_id=thread.thread_id,
                kind=RealtimeEventKind.TURN_STARTED,
                bot_id=bot_id,
            )
        )
        return stream.stream_id

    def append_turn_token(self, stream_id: str, token: str) -> None:
        """Push one token on the realtime API. Does not write a message row.

        :raises TurnStreamNotFoundError: If the stream is unknown.
        """
        stream = self._streams.get(stream_id)
        if stream is None:
            raise TurnStreamNotFoundError(f"Turn stream {stream_id!r} does not exist.")
        stream.tokens.append(token)
        self._fanout(
            RealtimeEvent(
                event_id=str(uuid4()),
                tenant_id=stream.tenant_id,
                thread_id=stream.thread_id,
                kind=RealtimeEventKind.TURN_TOKEN,
                bot_id=stream.bot_id,
                token=token,
            )
        )

    def complete_turn_stream(self, stream_id: str) -> Message:
        """Coalesce streamed tokens into one message row.

        Completing a stream does not enqueue another turn.

        :raises TurnStreamNotFoundError: If the stream is unknown.
        """
        stream = self._streams.pop(stream_id, None)
        if stream is None:
            raise TurnStreamNotFoundError(f"Turn stream {stream_id!r} does not exist.")
        body = "".join(stream.tokens)
        message = self.post_message(
            stream.thread_id,
            stream.tenant_id,
            ActorKind.BOT,
            stream.bot_id,
            body,
            enqueue_turn=False,
        )
        self._fanout(
            RealtimeEvent(
                event_id=str(uuid4()),
                tenant_id=stream.tenant_id,
                thread_id=stream.thread_id,
                kind=RealtimeEventKind.TURN_COMPLETED,
                message_seq=message.seq,
                message_id=message.message_id,
                bot_id=stream.bot_id,
                body=body,
            )
        )
        return message

    def _require_thread_tenant(self, thread_id: str, tenant_id: str) -> Thread:
        thread = self.thread(thread_id)
        if thread.tenant_id != tenant_id:
            raise ThreadTenantMismatchError(
                f"Tenant {tenant_id!r} does not own thread {thread_id!r}."
            )
        return thread

    def _require_participant(
        self,
        thread: Thread,
        kind: ActorKind,
        actor_id: str,
    ) -> None:
        for participant in thread.participants:
            if participant.kind == kind and participant.actor_id == actor_id:
                return
        raise ActorNotInThreadError(
            f"{kind} {actor_id!r} is not a participant of thread "
            f"{thread.thread_id!r}."
        )

    def _fanout(self, event: RealtimeEvent) -> None:
        for subscription in self._subscriptions.values():
            if (
                subscription.tenant_id == event.tenant_id
                and subscription.thread_id == event.thread_id
            ):
                subscription.events.append(event)


def _disk_checksum(workspace: dict[str, str], browser_sessions: dict[str, str]) -> str:
    payload = json.dumps(
        {"workspace": workspace, "browser_sessions": browser_sessions},
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode()).hexdigest()
