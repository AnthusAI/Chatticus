"""Validate rules and approvals against a member authority ceiling."""

from __future__ import annotations

from dataclasses import dataclass

from chatticus.approval_binding import StructuredConsequentialOperation
from chatticus.capability_policy import (
    EgressClass,
    RequestedCapability,
    TaskCapabilityGrant,
)
from chatticus.ceiling import Ceiling, grant_exceeds_ceiling
from chatticus.models import CONSEQUENTIAL_ACTION_TYPES, MemberRole

STRUCTURED_ARGUMENT_ALIASES = {
    "recipient": "destination",
    "destination": "destination",
    "body": "payload",
    "payload": "payload",
}


@dataclass(frozen=True)
class MemberAuthorityCeiling:
    """Standing authority one member holds for one consequential class."""

    grant_ceiling: Ceiling
    structured_argument_bindings: tuple[tuple[str, str], ...] = ()


@dataclass(frozen=True)
class MemberStanding:
    """Resolved standing for one member at a capability sink."""

    role_ceiling: Ceiling
    per_action_ceiling: MemberAuthorityCeiling | None = None

    @classmethod
    def owner(cls) -> MemberStanding:
        """Return unrestricted owner standing for kernel-only sink tests."""
        from chatticus.roles import ceiling_for_member_role

        return cls(role_ceiling=ceiling_for_member_role(MemberRole.OWNER))


def task_grant_for_requested_capability(
    request: RequestedCapability,
) -> TaskCapabilityGrant:
    """Build the task grant one sink request represents."""
    tools = frozenset({request.tool}) if request.tool else frozenset()
    origins = frozenset({request.origin}) if request.origin else frozenset()
    recipients = frozenset({request.recipient}) if request.recipient else frozenset()
    file_scopes = frozenset({request.file_path}) if request.file_path else frozenset()
    egress_classes = (
        frozenset({request.egress_class}) if request.egress_class else frozenset()
    )
    return TaskCapabilityGrant(
        tools=tools,
        origins=origins,
        recipients=recipients,
        file_scopes=file_scopes,
        egress_classes=egress_classes,
        ingest_classes=frozenset(),
    )


def request_exceeds_member_standing(
    request: RequestedCapability,
    standing: MemberStanding,
    *,
    structured_arguments: dict[str, str] | None = None,
) -> bool:
    """Return whether one sink request exceeds the member's standing."""
    if request.tool in CONSEQUENTIAL_ACTION_TYPES:
        if request.tool not in standing.role_ceiling.action_types:
            return True
    per_action = standing.per_action_ceiling
    if per_action is None:
        return False
    grant = task_grant_for_requested_capability(request)
    if grant_exceeds_member_authority_ceiling(grant, per_action):
        return True
    if per_action.structured_argument_bindings and structured_arguments:
        ceiling_bindings = dict(per_action.structured_argument_bindings)
        return not structured_bindings_within_ceiling_bindings(
            structured_arguments,
            ceiling_bindings,
        )
    return False


def normalize_structured_arguments(arguments: dict[str, str]) -> dict[str, str]:
    """Map structured argument names to one canonical vocabulary."""
    normalized: dict[str, str] = {}
    for key, value in arguments.items():
        canonical = STRUCTURED_ARGUMENT_ALIASES.get(key, key)
        normalized[canonical] = value
    return normalized


def _egress_for_action(action_type: str) -> str | None:
    if action_type == "send":
        return EgressClass.STRUCTURED_SEND.value
    if action_type in CONSEQUENTIAL_ACTION_TYPES:
        return EgressClass.FILE_TRANSFER.value
    return None


def task_grant_for_structured_arguments(
    action_type: str,
    arguments: dict[str, str],
) -> TaskCapabilityGrant:
    """Build the task grant one structured consequential action requests."""
    normalized = normalize_structured_arguments(arguments)
    recipient = normalized.get("destination")
    egress = _egress_for_action(action_type)
    tools = (
        frozenset({action_type})
        if action_type in CONSEQUENTIAL_ACTION_TYPES
        else frozenset()
    )
    return TaskCapabilityGrant(
        tools=tools,
        origins=frozenset(),
        recipients=frozenset({recipient}) if recipient else frozenset(),
        file_scopes=frozenset(),
        egress_classes=frozenset({egress}) if egress else frozenset(),
        ingest_classes=frozenset(),
    )


def task_grant_for_structured_operation(
    operation: StructuredConsequentialOperation,
) -> TaskCapabilityGrant:
    """Build the task grant one immutable approval authorizes."""
    return task_grant_for_structured_arguments(
        operation.action_type,
        {"destination": operation.destination, "payload": operation.payload},
    )


def structured_bindings_within_ceiling_bindings(
    attempted: dict[str, str],
    ceiling_bindings: dict[str, str],
) -> bool:
    """Return whether attempted bindings stay within the ceiling argument bindings."""
    if not ceiling_bindings:
        return True
    normalized_attempted = normalize_structured_arguments(attempted)
    normalized_ceiling = normalize_structured_arguments(ceiling_bindings)
    return all(
        normalized_attempted.get(key) == value
        for key, value in normalized_ceiling.items()
    )


def member_authority_ceiling_from_structured_arguments(
    action_type: str,
    arguments: dict[str, str],
) -> MemberAuthorityCeiling:
    """Build a member ceiling from one structured consequential binding table."""
    normalized = normalize_structured_arguments(arguments)
    recipient = normalized.get("destination")
    egress = _egress_for_action(action_type)
    return MemberAuthorityCeiling(
        grant_ceiling=Ceiling(
            action_types=frozenset({action_type}),
            origins=frozenset(),
            recipients=frozenset({recipient}) if recipient else frozenset(),
            file_scopes=frozenset(),
            egress_classes=frozenset({egress}) if egress else frozenset(),
            ingest_classes=frozenset(),
        ),
        structured_argument_bindings=tuple(sorted(arguments.items())),
    )


def grant_exceeds_member_authority_ceiling(
    grant: TaskCapabilityGrant,
    member_ceiling: MemberAuthorityCeiling | None,
) -> bool:
    """Return whether ``grant`` exceeds the member standing ceiling."""
    if member_ceiling is None:
        return False
    return grant_exceeds_ceiling(grant, member_ceiling.grant_ceiling)


def auto_review_rule_exceeds_member_authority_ceiling(
    action_type: str,
    argument_bindings: dict[str, str],
    member_ceiling: MemberAuthorityCeiling | None,
) -> bool:
    """Return whether an auto-review rule exceeds the author's standing."""
    if member_ceiling is None:
        return False
    grant = task_grant_for_structured_arguments(action_type, argument_bindings)
    if grant_exceeds_member_authority_ceiling(grant, member_ceiling):
        return True
    if member_ceiling.structured_argument_bindings:
        ceiling_bindings = dict(member_ceiling.structured_argument_bindings)
        return not structured_bindings_within_ceiling_bindings(
            argument_bindings,
            ceiling_bindings,
        )
    return False


def structured_operation_exceeds_member_authority_ceiling(
    operation: StructuredConsequentialOperation,
    member_ceiling: MemberAuthorityCeiling | None,
) -> bool:
    """Return whether an approval would exceed the approver's standing."""
    if member_ceiling is None:
        return False
    grant = task_grant_for_structured_operation(operation)
    if grant_exceeds_member_authority_ceiling(grant, member_ceiling):
        return True
    if member_ceiling.structured_argument_bindings:
        attempted = {
            "destination": operation.destination,
            "payload": operation.payload,
        }
        ceiling_bindings = dict(member_ceiling.structured_argument_bindings)
        return not structured_bindings_within_ceiling_bindings(
            attempted,
            ceiling_bindings,
        )
    return False
