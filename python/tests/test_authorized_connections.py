"""Unit tests for authorized connections between organizations."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from chatticus.authorization_ceiling import (
    connection_proposal_exceeds_member_authority_ceiling,
    member_authority_ceiling_from_structured_arguments,
)
from chatticus.authorized_connections import (
    InvalidConnectionTargetError,
    authorize_connection_from_proposal,
    find_escalation_target_user_id,
    member_covers_connection_proposal,
    new_connection_proposal,
    org_egress_allows_connection,
    validate_connection_target,
)
from chatticus.control_plane import ControlPlane
from chatticus.models import CONNECTION_STANDING_ACTION_TYPE

NOW = datetime(2026, 8, 31, 12, 0, 0, tzinfo=UTC)


def _connection_ceiling(
    *,
    channel: str,
    receiving_tenant: str,
) -> object:
    return member_authority_ceiling_from_structured_arguments(
        CONNECTION_STANDING_ACTION_TYPE,
        {"channel": channel, "receiving_tenant": receiving_tenant},
    )


def test_connection_standing_is_not_a_consequential_tool() -> None:
    from chatticus.models import CONSEQUENTIAL_ACTION_TYPES

    assert CONNECTION_STANDING_ACTION_TYPE not in CONSEQUENTIAL_ACTION_TYPES


def test_workplace_level_connection_target_is_refused() -> None:
    with pytest.raises(InvalidConnectionTargetError, match="never the workplace"):
        validate_connection_target(
            permission="read",
            channel_name="/workspace/secrets",
        )


def test_member_covers_matching_connection_bindings() -> None:
    proposal = new_connection_proposal(
        granting_tenant_id="anthus",
        receiving_tenant_id="partner",
        channel_id="ch-1",
        channel_name="support-queue",
        permission="read",
        proposer_user_id="sam",
    )
    ceiling = _connection_ceiling(channel="support-queue", receiving_tenant="partner")

    assert member_covers_connection_proposal(proposal, ceiling) is True
    assert (
        connection_proposal_exceeds_member_authority_ceiling(
            "support-queue",
            "partner",
            ceiling,
        )
        is False
    )


def test_borrowed_standing_is_not_part_of_receiver_ceiling() -> None:
    plane = ControlPlane()
    plane.admin_seed_organization("anthus", "ryan@example.com", name="Anthus", now=NOW)
    plane.admin_seed_organization(
        "partner", "alex@example.com", name="Partner", now=NOW
    )
    owner = plane.sign_in("ryan@example.com", now=NOW)
    sam = plane.sign_in("sam@example.com", now=NOW)
    invitation = plane.invite_by_email(
        "anthus", owner.user_id, "sam@example.com", now=NOW
    )
    plane.accept_invitation(invitation.invitation_id, sam, now=NOW)
    plane.set_member_authority_ceiling(
        "anthus",
        sam.user_id,
        CONNECTION_STANDING_ACTION_TYPE,
        arguments={"channel": "support-queue", "receiving_tenant": "partner"},
    )
    channel = plane.create_channel("anthus", owner.user_id, [])
    result = plane.propose_connection(
        "anthus",
        sam.user_id,
        "partner",
        channel.channel_id,
        "support-queue",
    )
    assert result.authorized is not None

    partner_member = plane.sign_in("alex@example.com", now=NOW)
    plane.set_member_authority_ceiling(
        "partner",
        partner_member.user_id,
        CONNECTION_STANDING_ACTION_TYPE,
        arguments={"channel": "partner-only", "receiving_tenant": "other"},
    )
    partner_ceiling = plane.member_authority_ceiling(
        "partner",
        partner_member.user_id,
        CONNECTION_STANDING_ACTION_TYPE,
    )
    assert (
        connection_proposal_exceeds_member_authority_ceiling(
            "support-queue",
            "other",
            partner_ceiling,
        )
        is True
    )


def test_org_egress_clips_connection_when_narrower_than_proposer() -> None:
    proposal = new_connection_proposal(
        granting_tenant_id="anthus",
        receiving_tenant_id="partner",
        channel_id="ch-1",
        channel_name="support-queue",
        permission="read",
        proposer_user_id="sam",
    )
    proposer_ceiling = _connection_ceiling(
        channel="support-queue",
        receiving_tenant="partner",
    )
    org_egress = _connection_ceiling(
        channel="support-queue",
        receiving_tenant="other",
    )

    assert member_covers_connection_proposal(proposal, proposer_ceiling) is True
    assert org_egress_allows_connection(proposal, org_egress) is False


def test_find_escalation_target_prefers_covering_member_other_than_proposer() -> None:
    proposal = new_connection_proposal(
        granting_tenant_id="anthus",
        receiving_tenant_id="partner",
        channel_id="ch-1",
        channel_name="legal-review",
        permission="read",
        proposer_user_id="sam",
    )
    sam_ceiling = _connection_ceiling(
        channel="support-queue",
        receiving_tenant="partner",
    )
    ryan_ceiling = _connection_ceiling(
        channel="legal-review",
        receiving_tenant="partner",
    )
    ceilings = {"sam": sam_ceiling, "ryan": ryan_ceiling}

    target = find_escalation_target_user_id(
        proposal,
        member_user_ids=["sam", "ryan"],
        ceiling_for_member=ceilings.get,
    )

    assert target == "ryan"


def test_authorized_connection_records_clip_metadata() -> None:
    proposal = new_connection_proposal(
        granting_tenant_id="anthus",
        receiving_tenant_id="partner",
        channel_id="ch-1",
        channel_name="support-queue",
        permission="read",
        proposer_user_id="sam",
    )
    authorized = authorize_connection_from_proposal(
        proposal,
        clipped_by_user_id="sam",
        created_at=NOW,
    )

    assert authorized.clipped_by_user_id == "sam"
    assert authorized.channel_name == "support-queue"
    assert authorized.receiving_tenant_id == "partner"
