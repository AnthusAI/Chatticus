"""Domain types for the Chatticus control plane."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum


class CostClass(StrEnum):
    """Where a worker runs, used to prefer cheaper capacity first."""

    LOCAL = "local"
    EC2 = "ec2"
    FARGATE = "fargate"


class ComputerPolicy(StrEnum):
    """How a workplace may choose hosts.

    Stored on the computer; a turn may override it.
    """

    PREFER_LOCAL = "prefer_local"
    AWS_ONLY = "aws_only"
    LOCAL_ONLY = "local_only"


class ApprovalDecision(StrEnum):
    """Result of evaluating a proposed action."""

    ALLOW = "allow"
    REQUIRE_APPROVAL = "require_approval"
    DENY = "deny"


class AutoReviewRuleKind(StrEnum):
    """Personal auto-review rule kinds.

    Never-allow wins over require-approval. Require-approval wins over
    always-allow.
    """

    REQUIRE_APPROVAL = "require_approval"
    ALWAYS_ALLOW = "always_allow"
    NEVER_ALLOW = "never_allow"


CONSEQUENTIAL_ACTION_TYPES = frozenset(
    {
        "send",
        "publish",
        "purchase",
        "delete",
        "production_change",
    }
)

COST_CLASS_RANK = {
    CostClass.LOCAL: 0,
    CostClass.EC2: 1,
    CostClass.FARGATE: 2,
}

AWS_COST_CLASSES = frozenset({CostClass.EC2, CostClass.FARGATE})


class ChatticusError(Exception):
    """Base error for control-plane protocol violations."""


class WorkerTenantMismatchError(ChatticusError):
    """A worker_id cannot move from one tenant to another by re-registering."""


class DuplicateBotNameError(ChatticusError):
    """Bot names are unique per tenant user."""


class SnapshotRequiredError(ChatticusError):
    """Relocate and hydrate need a published snapshot in object storage."""


class ComputerDirtyError(ChatticusError):
    """Relocate is blocked until the live disk is published."""


class WorkerDoesNotHostComputerError(ChatticusError):
    """The worker's computer_id does not match this workplace."""


class ComputerNotHydratedError(ChatticusError):
    """The live disk is not writable until the intended host hydrates."""


class ActorKind(StrEnum):
    """Who can author a thread message."""

    HUMAN = "human"
    BOT = "bot"


class TurnEventKind(StrEnum):
    """Durable events for one turn-scoped server-sent event stream."""

    CHANNEL_MESSAGE_CREATED = "channel.message.created"
    TURN_STARTED = "turn.started"
    TURN_WAITING = "turn.waiting"
    TURN_TOKEN = "turn.token"
    TURN_COMPLETED = "turn.completed"
    TURN_FAILED = "turn.failed"
    TURN_RECONCILING = "turn.reconciling"
    MODEL_REQUEST = "model.request"
    TOOL_CALL = "tool.call"
    TOOL_RESULT = "tool.result"
    ATTEMPT_CLAIMED = "attempt.claimed"
    ATTEMPT_RELINQUISHED = "attempt.relinquished"


class TurnStatus(StrEnum):
    """Lifecycle of one bot turn."""

    ACTIVE = "active"
    COMPLETED = "completed"
    FAILED = "failed"
    RECONCILING = "reconciling"


class ChannelNotFoundError(ChatticusError):
    """The channel id is unknown."""


class ChannelTenantMismatchError(ChatticusError):
    """A tenant cannot read or write another tenant's channel."""


class ActorNotInChannelError(ChatticusError):
    """The author or addressee is not a participant of the channel."""


class TurnNotFoundError(ChatticusError):
    """The turn id is unknown."""


class TurnAccessDeniedError(ChatticusError):
    """A tenant cannot open another tenant's turn stream."""


class StaleAttemptError(ChatticusError):
    """A fenced attempt tried to write after the turn changed owners."""


class TurnClaimDeniedError(ChatticusError):
    """Another unexpired attempt already owns the turn."""


class TurnReconcilingError(ChatticusError):
    """A consequential action cannot run while reconciliation is pending."""


class TurnTerminalError(ChatticusError):
    """The turn already reached a terminal state."""


class TurnNotWaitingError(ChatticusError):
    """Resume was called on a turn that is not blocked on a readiness gate."""


class ComputerNotReadyError(ChatticusError):
    """The household computer is still stopped, so the waiting turn cannot resume."""


class ComputerlessCannotExecuteComputerJob(ChatticusError):
    """A cpu-only worker must not ack a job that requires the computer."""


class ComputerWorkerRequiresComputerCapability(ChatticusError):
    """A computer-capable worker must not ack a job without the computer capability."""


class ComputerWorkerHostNotReady(ChatticusError):
    """Leave the computer SQS job unacked until a real host can run the tool."""


class TaskNotFoundError(ChatticusError):
    """The task id is unknown to this tenant."""


class TaskAccessDeniedError(ChatticusError):
    """A tenant cannot read or write another tenant's task."""


class TaskEvidenceRequiredError(ChatticusError):
    """A task may not reach completed without durable evidence."""


class TaskCloseReasonRequiredError(ChatticusError):
    """Closing a task requires a recorded reason."""


class TaskStatus(StrEnum):
    """Lifecycle of one durable Task item outside the channel."""

    OPEN = "open"
    BLOCKED = "blocked"
    COMPLETED = "completed"
    CLOSED = "closed"


class OrganizationStatus(StrEnum):
    """Lifecycle of one organization."""

    PENDING = "pending"
    ENABLED = "enabled"
    SUSPENDED = "suspended"


class MemberRole(StrEnum):
    """Role of one member inside an organization."""

    OWNER = "owner"
    MEMBER = "member"


class InvitationStatus(StrEnum):
    """Lifecycle of one organization invitation."""

    PENDING = "pending"
    ACCEPTED = "accepted"
    EXPIRED = "expired"


class IdentityNotFoundError(ChatticusError):
    """The user id or email is unknown."""


class IdentityUserIdMismatchError(ChatticusError):
    """An existing identity email maps to a different user_id than required."""


class OrganizationSeedConflictError(ChatticusError):
    """An organization seed would overwrite or contradict existing records."""


class OrganizationNotFoundError(ChatticusError):
    """The organization is unknown."""


class OrganizationNotEnabledError(ChatticusError):
    """The organization is not enabled yet."""


class OrganizationStatusTransitionError(ChatticusError):
    """The organization status does not allow this transition."""


class InvitationNotFoundError(ChatticusError):
    """The invitation is unknown."""


class InvitationEmailMismatchError(ChatticusError):
    """The acceptor email does not match the invitation."""


class DuplicateMembershipError(ChatticusError):
    """The user is already a member of the organization."""


class MembershipNotFoundError(ChatticusError):
    """The user is not a member of the organization."""


class InvitationNotPendingError(ChatticusError):
    """The invitation is not pending."""


class InvitationExpiredError(ChatticusError):
    """The invitation has expired."""


class NotOrganizationOwnerError(ChatticusError):
    """Only an owner may perform this action."""


class LastOwnerCannotBeDemotedError(ChatticusError):
    """An organization must keep at least one owner."""


@dataclass(frozen=True)
class WorkerRegistration:
    """Advertisement a worker sends when it plugs into the control plane."""

    worker_id: str
    tenant_id: str
    cost_class: CostClass
    capabilities: frozenset[str]
    computer_id: str | None = None


@dataclass
class WorkerCredentialMint:
    """One-time worker bearer credential returned at registration."""

    worker_id: str
    token: str


@dataclass
class WorkerRecord:
    """Registered worker plus last heartbeat."""

    registration: WorkerRegistration
    last_heartbeat_at: datetime
    token_hash: str
    hydrated_snapshot_generation: int | None = None


@dataclass(frozen=True)
class TurnJob:
    """Work a worker may pull."""

    job_id: str
    tenant_id: str
    required_capabilities: frozenset[str]
    computer_policy: ComputerPolicy = ComputerPolicy.PREFER_LOCAL
    computer_id: str | None = None
    user_id: str | None = None
    bot_id: str | None = None
    turn_id: str | None = None


@dataclass(frozen=True)
class AutoReviewRule:
    """A narrow auto-review rule matching an action type for one tenant.

    Overnight pre-authorization requires ``created_by="human"`` and
    ``argument_bindings`` that equal the concrete operation.
    """

    kind: AutoReviewRuleKind
    action_type: str
    tenant_id: str
    user_id: str | None = None
    argument_bindings: tuple[tuple[str, str], ...] = ()
    created_by: str = "human"


@dataclass
class Bot:
    """A named teammate. Memory is per-bot, not shared on the computer."""

    bot_id: str
    tenant_id: str
    user_id: str
    name: str
    memory: dict[str, str] = field(default_factory=dict)


@dataclass
class ComputerSnapshot:
    """Canonical workplace disk as it would appear in S3.

    The in-memory kernel stores file bytes here. Production stores a pack
    at ``snapshot_uri``; this record is the control-plane view of that
    object.
    """

    snapshot_uri: str
    checksum: str
    workspace: dict[str, str]
    browser_sessions: dict[str, str]
    published_at: datetime
    published_by_worker_id: str


@dataclass
class Computer:
    """User-scoped workplace. Shared by every bot of that user.

    Local and AWS workers that host this workplace share the same
    ``computer_id``. That is how a pin survives failover from a garage Mac
    to Fargate.

    Durable files and the browser profile are a snapshot in object storage,
    not a particular host's overlay. A host hydrates a local cache, runs,
    and publishes before another host takes over. See
    ``docs/COMPUTER_SNAPSHOTS.md``.
    """

    computer_id: str
    tenant_id: str
    user_id: str
    policy: ComputerPolicy = ComputerPolicy.PREFER_LOCAL
    workspace: dict[str, str] = field(default_factory=dict)
    browser_sessions: dict[str, str] = field(default_factory=dict)
    snapshot_uri: str | None = None
    snapshot_checksum: str | None = None
    snapshot_generation: int = 0
    model_ready: bool = True
    workspace_ready: bool = False
    browser_ready: bool = False
    host_start_generation: int = 0
    host_start_dispatched_generation: int = 0
    host_start_lease_expires_at: datetime | None = None
    disk_dirty: bool = False
    hydrate_required: bool = False
    intended_host_worker_id: str | None = None
    stopped: bool = False


@dataclass(frozen=True)
class ChannelParticipant:
    """A human or bot that can read and post in a channel."""

    kind: ActorKind
    actor_id: str


@dataclass
class Channel:
    """A conversation. Messages are append-only with a per-channel sequence."""

    channel_id: str
    tenant_id: str
    user_id: str
    participants: list[ChannelParticipant] = field(default_factory=list)
    next_seq: int = 1


@dataclass(frozen=True)
class Message:
    """One committed row in a channel. Streaming tokens are not messages."""

    message_id: str
    channel_id: str
    tenant_id: str
    seq: int
    author_kind: ActorKind
    author_id: str
    body: str
    addressed_to_bot_id: str | None
    created_at: datetime


@dataclass
class Turn:
    """One bot turn with durable events and optional in-flight chunks."""

    turn_id: str
    tenant_id: str
    channel_id: str
    bot_id: str
    status: TurnStatus = TurnStatus.ACTIVE
    next_event_seq: int = 1
    next_chunk_seq: int = 1
    attempt_id: str | None = None
    fence_token: int = 0
    claimed_by_worker_id: str | None = None
    lease_expires_at: datetime | None = None
    deadline_at: datetime | None = None
    recovery_attempts: int = 0
    terminal_reason: str | None = None
    ambiguous_provider_call_id: str | None = None
    waiting_for: str | None = None
    pending_computer_action_id: str | None = None
    pending_computer_tool_name: str | None = None
    prompt_message_seq: int | None = None


@dataclass(frozen=True)
class TurnAttempt:
    """The current fenced owner of one turn, if a claim succeeded."""

    tenant_id: str
    turn_id: str
    attempt_id: str
    fence_token: int
    worker_id: str
    acquired: bool
    lease_expires_at: datetime


@dataclass(frozen=True)
class PendingComputerToolSnapshot:
    """One pending computer tool call recorded on a waiting turn."""

    action_id: str
    tool_name: str
    arguments: dict[str, str]


def pending_computer_tool_from_turn(turn: Turn) -> PendingComputerToolSnapshot | None:
    """Return the pending computer tool on one turn, if any."""
    if turn.pending_computer_tool_name is None:
        return None
    return PendingComputerToolSnapshot(
        action_id=turn.pending_computer_action_id or "",
        tool_name=turn.pending_computer_tool_name,
        arguments={"gate": turn.waiting_for} if turn.waiting_for else {},
    )


@dataclass
class Task:
    """Thin v1 task state stored outside the channel transcript."""

    task_id: str
    tenant_id: str
    user_id: str
    title: str
    status: TaskStatus = TaskStatus.OPEN
    evidence: str | None = None
    close_reason: str | None = None
    created_by_bot_id: str | None = None
    updated_by_bot_id: str | None = None


@dataclass(frozen=True)
class Identity:
    """One global human account keyed by verified email."""

    user_id: str
    email: str
    created_at: datetime


@dataclass(frozen=True)
class Organization:
    """One organization; tenant_id is its identifier."""

    tenant_id: str
    name: str
    status: OrganizationStatus
    owner_user_id: str
    created_at: datetime


@dataclass(frozen=True)
class Membership:
    """One user's membership in one organization."""

    tenant_id: str
    user_id: str
    role: MemberRole
    joined_at: datetime


@dataclass(frozen=True)
class Invitation:
    """One pending or accepted invitation to join an organization."""

    invitation_id: str
    tenant_id: str
    email: str
    invited_by_user_id: str
    role: MemberRole
    status: InvitationStatus
    expires_at: datetime
    created_at: datetime


@dataclass(frozen=True)
class TurnEvent:
    """One durable event for turn-scoped server-sent events."""

    event_id: str
    tenant_id: str
    turn_id: str
    channel_id: str
    seq: int
    kind: TurnEventKind
    token: str | None = None
    message_seq: int | None = None
    body: str | None = None
    pending_computer_tool: PendingComputerToolSnapshot | None = None
    action_id: str | None = None
    attempt_id: str | None = None
