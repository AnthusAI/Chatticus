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


class RealtimeEventKind(StrEnum):
    """Events the realtime API pushes to a subscribed chattic.us session."""

    THREAD_MESSAGE_CREATED = "thread.message.created"
    TURN_STARTED = "turn.started"
    TURN_TOKEN = "turn.token"
    TURN_COMPLETED = "turn.completed"


class ThreadNotFoundError(ChatticusError):
    """The thread id is unknown."""


class ThreadTenantMismatchError(ChatticusError):
    """A tenant cannot read or write another tenant's thread."""


class ActorNotInThreadError(ChatticusError):
    """The author or addressee is not a participant of the thread."""


class TurnStreamNotFoundError(ChatticusError):
    """The turn stream id is unknown or already completed."""


@dataclass(frozen=True)
class WorkerRegistration:
    """Advertisement a worker sends when it plugs into the control plane."""

    worker_id: str
    tenant_id: str
    cost_class: CostClass
    capabilities: frozenset[str]
    computer_id: str | None = None


@dataclass
class WorkerRecord:
    """Registered worker plus last heartbeat."""

    registration: WorkerRegistration
    last_heartbeat_at: datetime


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


@dataclass(frozen=True)
class AutoReviewRule:
    """A narrow auto-review rule matching an action type for one tenant."""

    kind: AutoReviewRuleKind
    action_type: str
    tenant_id: str
    user_id: str | None = None


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
    disk_dirty: bool = False
    hydrate_required: bool = False
    intended_host_worker_id: str | None = None


@dataclass(frozen=True)
class ThreadParticipant:
    """A human or bot that can read and post in a thread."""

    kind: ActorKind
    actor_id: str


@dataclass
class Thread:
    """A conversation. Messages are append-only with a per-thread sequence."""

    thread_id: str
    tenant_id: str
    user_id: str
    participants: list[ThreadParticipant] = field(default_factory=list)
    next_seq: int = 1


@dataclass(frozen=True)
class Message:
    """One committed row in a thread. Streaming tokens are not messages."""

    message_id: str
    thread_id: str
    tenant_id: str
    seq: int
    author_kind: ActorKind
    author_id: str
    body: str
    addressed_to_bot_id: str | None
    created_at: datetime


@dataclass(frozen=True)
class RealtimeEvent:
    """One fan-out payload for the realtime API.

    Tokens travel here. They are not stored as message rows. After reconnect,
    the client replays committed messages with ``after=seq``.
    """

    event_id: str
    tenant_id: str
    thread_id: str
    kind: RealtimeEventKind
    message_seq: int | None = None
    message_id: str | None = None
    bot_id: str | None = None
    token: str | None = None
    body: str | None = None


@dataclass
class RealtimeSubscription:
    """A chattic.us session subscribed to one thread's realtime API."""

    subscription_id: str
    tenant_id: str
    thread_id: str
    events: list[RealtimeEvent] = field(default_factory=list)


@dataclass
class TurnStream:
    """In-flight token buffer for one bot turn. Not a message until complete."""

    stream_id: str
    thread_id: str
    tenant_id: str
    bot_id: str
    tokens: list[str] = field(default_factory=list)
