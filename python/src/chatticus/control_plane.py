"""In-memory control plane: workers, routing, roster, approvals."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import uuid4

from chatticus.models import (
    AWS_COST_CLASSES,
    CONSEQUENTIAL_ACTION_TYPES,
    COST_CLASS_RANK,
    ApprovalDecision,
    AutoReviewRule,
    AutoReviewRuleKind,
    Bot,
    Computer,
    ComputerPolicy,
    CostClass,
    TurnJob,
    WorkerRecord,
    WorkerRegistration,
)


class ControlPlane:
    """Tenant-aware control plane used by the product behavior specs.

    This is the protocol kernel. HTTP, SQS, and the computer image sit on
    top of the same rules.
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
        self._auto_review_rules: list[AutoReviewRule] = []

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
        """Register or replace a worker and record a heartbeat."""
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

    def heartbeat_all_except(self, worker_id: str) -> None:
        """Refresh every worker heartbeat except the named worker."""
        for record in self._workers.values():
            if record.registration.worker_id != worker_id:
                record.last_heartbeat_at = self._now

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
        computer_policy: ComputerPolicy = ComputerPolicy.PREFER_LOCAL,
        computer_id: str | None = None,
    ) -> TurnJob:
        """Create a turn job. Assignment happens in ``assign_turn``."""
        return TurnJob(
            job_id=str(uuid4()),
            tenant_id=tenant_id,
            required_capabilities=required_capabilities,
            computer_policy=computer_policy,
            computer_id=computer_id,
        )

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
        """Create a named bot and ensure the user has a computer."""
        self.ensure_computer(tenant_id, user_id)
        bot = Bot(
            bot_id=str(uuid4()),
            tenant_id=tenant_id,
            user_id=user_id,
            name=name,
        )
        self._bots[bot.bot_id] = bot
        return bot

    def ensure_computer(self, tenant_id: str, user_id: str) -> Computer:
        """Return the user's computer, creating it if needed."""
        key = (tenant_id, user_id)
        computer = self._computers_by_user.get(key)
        if computer is None:
            computer = Computer(
                computer_id=str(uuid4()),
                tenant_id=tenant_id,
                user_id=user_id,
            )
            self._computers_by_user[key] = computer
        return computer

    def computer_for_user(self, tenant_id: str, user_id: str) -> Computer:
        """
        Return the existing computer for a user.

        :raises KeyError: If the user has no computer.
        """
        return self._computers_by_user[(tenant_id, user_id)]

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
        self.computer_for_user(tenant_id, user_id).workspace[path] = content

    def read_workspace(self, tenant_id: str, user_id: str, path: str) -> str | None:
        """Read a file from the user's shared computer."""
        return self.computer_for_user(tenant_id, user_id).workspace.get(path)

    def save_browser_session(
        self, tenant_id: str, user_id: str, service: str, session: str
    ) -> None:
        """Persist a browser session on the user's computer."""
        self.computer_for_user(tenant_id, user_id).browser_sessions[service] = session

    def browser_session(self, tenant_id: str, user_id: str, service: str) -> str | None:
        """Return a saved browser session, if present."""
        return self.computer_for_user(tenant_id, user_id).browser_sessions.get(service)

    def add_auto_review_rule(self, kind: AutoReviewRuleKind, action_type: str) -> None:
        """Add a personal auto-review rule."""
        self._auto_review_rules.append(
            AutoReviewRule(kind=kind, action_type=action_type)
        )

    def evaluate_action(self, action_type: str) -> ApprovalDecision:
        """Evaluate a proposed action against defaults and auto-review rules."""
        matching = [
            rule for rule in self._auto_review_rules if rule.action_type == action_type
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
