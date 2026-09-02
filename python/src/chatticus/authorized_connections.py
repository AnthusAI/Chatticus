"""Authorized connections between organizations as channel-scoped clips.

A connection grants borrowed standing on one named channel in the granting
organization. It is not a consequential tool and is not part of the receiver's
authority ceiling.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from uuid import uuid4

from chatticus.authorization_ceiling import (
    MemberAuthorityCeiling,
    connection_proposal_exceeds_member_authority_ceiling,
    structured_bindings_within_ceiling_bindings,
)
from chatticus.models import ChatticusError

CONNECTION_PERMISSION_READ = "read"


class ConnectionProposalStatus(StrEnum):
    """Lifecycle of one connection proposal."""

    AUTHORIZED = "authorized"
    REFUSED = "refused"
    PENDING_ESCALATION = "pending_escalation"
    BLOCKED = "blocked"


class InvalidConnectionTargetError(ChatticusError):
    """A connection may reach a channel only, never the workplace."""


@dataclass(frozen=True)
class ConnectionProposal:
    """One member-proposed cross-organization channel read clip."""

    proposal_id: str
    granting_tenant_id: str
    receiving_tenant_id: str
    channel_id: str
    channel_name: str
    permission: str
    proposer_user_id: str


@dataclass(frozen=True)
class AuthorizedConnection:
    """Borrowed standing one receiving tenant holds on one channel."""

    connection_id: str
    granting_tenant_id: str
    receiving_tenant_id: str
    channel_id: str
    channel_name: str
    permission: str
    clipped_by_user_id: str
    created_at: datetime


@dataclass(frozen=True)
class ConnectionProposalRoute:
    """Routing outcome for one connection proposal."""

    proposal_id: str
    status: ConnectionProposalStatus
    escalation_target_user_id: str | None = None


@dataclass(frozen=True)
class ConnectionProposalResult:
    """Outcome of proposing or trying to propose one connection."""

    proposal: ConnectionProposal | None
    route: ConnectionProposalRoute | None
    authorized: AuthorizedConnection | None
    refused: bool = False


def connection_argument_bindings(
    *,
    channel_name: str,
    receiving_tenant_id: str,
) -> dict[str, str]:
    """Return the structured bindings one connection proposal carries."""
    return {
        "channel": channel_name,
        "receiving_tenant": receiving_tenant_id,
    }


def validate_connection_target(*, permission: str, channel_name: str) -> None:
    """Refuse workplace-level or unsupported connection targets."""
    if permission != CONNECTION_PERMISSION_READ:
        msg = f"Unsupported connection permission {permission!r}."
        raise InvalidConnectionTargetError(msg)
    if channel_name.startswith("/"):
        msg = "Connections may reach a channel only, never the workplace."
        raise InvalidConnectionTargetError(msg)


def member_covers_connection_proposal(
    proposal: ConnectionProposal,
    member_ceiling: MemberAuthorityCeiling | None,
) -> bool:
    """Return whether one member ceiling covers the proposal bindings."""
    if member_ceiling is None:
        return False
    bindings = connection_argument_bindings(
        channel_name=proposal.channel_name,
        receiving_tenant_id=proposal.receiving_tenant_id,
    )
    ceiling_bindings = dict(member_ceiling.structured_argument_bindings)
    return structured_bindings_within_ceiling_bindings(bindings, ceiling_bindings)


def org_egress_allows_connection(
    proposal: ConnectionProposal,
    org_egress_ceiling: MemberAuthorityCeiling | None,
) -> bool:
    """Return whether the granting tenant permits this connection to leave."""
    if org_egress_ceiling is None:
        return True
    return member_covers_connection_proposal(proposal, org_egress_ceiling)


def find_escalation_target_user_id(
    proposal: ConnectionProposal,
    *,
    member_user_ids: list[str],
    ceiling_for_member: Callable[[str], MemberAuthorityCeiling | None],
) -> str | None:
    """Return the nearest member whose ceiling covers the proposal."""
    covering: list[str] = []
    for user_id in member_user_ids:
        ceiling = ceiling_for_member(user_id)
        if member_covers_connection_proposal(proposal, ceiling):
            covering.append(user_id)
    if not covering:
        return None
    others = sorted(
        user_id for user_id in covering if user_id != proposal.proposer_user_id
    )
    if others:
        return others[0]
    return sorted(covering)[0]


def new_connection_proposal(
    *,
    granting_tenant_id: str,
    receiving_tenant_id: str,
    channel_id: str,
    channel_name: str,
    permission: str,
    proposer_user_id: str,
) -> ConnectionProposal:
    """Build one validated connection proposal."""
    validate_connection_target(permission=permission, channel_name=channel_name)
    return ConnectionProposal(
        proposal_id=uuid4().hex,
        granting_tenant_id=granting_tenant_id,
        receiving_tenant_id=receiving_tenant_id,
        channel_id=channel_id,
        channel_name=channel_name,
        permission=permission,
        proposer_user_id=proposer_user_id,
    )


def authorize_connection_from_proposal(
    proposal: ConnectionProposal,
    *,
    clipped_by_user_id: str,
    created_at: datetime,
) -> AuthorizedConnection:
    """Persist one authorized clip from a covered proposal."""
    return AuthorizedConnection(
        connection_id=uuid4().hex,
        granting_tenant_id=proposal.granting_tenant_id,
        receiving_tenant_id=proposal.receiving_tenant_id,
        channel_id=proposal.channel_id,
        channel_name=proposal.channel_name,
        permission=proposal.permission,
        clipped_by_user_id=clipped_by_user_id,
        created_at=created_at,
    )


def proposer_may_authorize_immediately(
    proposal: ConnectionProposal,
    proposer_ceiling: MemberAuthorityCeiling | None,
    org_egress_ceiling: MemberAuthorityCeiling | None,
) -> bool:
    """Return whether the proposer may self-authorize this connection."""
    if connection_proposal_exceeds_member_authority_ceiling(
        proposal.channel_name,
        proposal.receiving_tenant_id,
        proposer_ceiling,
    ):
        return False
    return org_egress_allows_connection(proposal, org_egress_ceiling)
