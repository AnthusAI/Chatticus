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
    TURN_TOKEN = "turn.token"
    TURN_COMPLETED = "turn.completed"


class TurnStatus(StrEnum):
    """Lifecycle of one bot turn."""

    ACTIVE = "active"
    COMPLETED = "completed"


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
    turn_id: str | None = None


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
