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
    """How a turn may choose a workplace."""

    PREFER_LOCAL = "prefer_local"
    AWS_ONLY = "aws_only"
    LOCAL_ONLY = "local_only"


class ApprovalDecision(StrEnum):
    """Result of evaluating a proposed action."""

    ALLOW = "allow"
    REQUIRE_APPROVAL = "require_approval"
    DENY = "deny"


class AutoReviewRuleKind(StrEnum):
    """Personal auto-review rule kinds. Require-approval wins over always-allow."""

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


@dataclass(frozen=True)
class AutoReviewRule:
    """A narrow auto-review rule matching an action type."""

    kind: AutoReviewRuleKind
    action_type: str


@dataclass
class Bot:
    """A named teammate. Memory is per-bot, not shared on the computer."""

    bot_id: str
    tenant_id: str
    user_id: str
    name: str
    memory: dict[str, str] = field(default_factory=dict)


@dataclass
class Computer:
    """User-scoped workplace. Shared by every bot of that user."""

    computer_id: str
    tenant_id: str
    user_id: str
    workspace: dict[str, str] = field(default_factory=dict)
    browser_sessions: dict[str, str] = field(default_factory=dict)
