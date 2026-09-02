"""Unit tests for authorization identity and ceiling validation."""

from __future__ import annotations

from chatticus.approval_binding import StructuredConsequentialOperation
from chatticus.authorization_ceiling import (
    MemberAuthorityCeiling,
    auto_review_rule_exceeds_member_authority_ceiling,
    member_authority_ceiling_from_structured_arguments,
    structured_bindings_within_ceiling_bindings,
    structured_operation_exceeds_member_authority_ceiling,
    task_grant_for_structured_arguments,
)
from chatticus.ceiling import Ceiling, grant_exceeds_ceiling
from chatticus.control_plane import ControlPlane
from chatticus.models import ActorKind, AuthorizationIdentity, AutoReviewRuleKind


def test_auto_review_rule_records_creator_distinct_from_scope() -> None:
    plane = ControlPlane()
    plane.add_auto_review_rule(
        AutoReviewRuleKind.ALWAYS_ALLOW,
        "send",
        "anthus",
        user_id="sam@example.com",
        arguments={"recipient": "alex@example.com", "body": "hello"},
        creator=AuthorizationIdentity.human("ryan@example.com"),
    )

    rule = plane._auto_review_rules[-1]
    assert rule.creator == AuthorizationIdentity.human("ryan@example.com")
    assert rule.user_id == "sam@example.com"


def test_bot_creator_cannot_author_always_allow_rule() -> None:
    plane = ControlPlane()
    recorded = plane.add_auto_review_rule(
        AutoReviewRuleKind.ALWAYS_ALLOW,
        "send",
        "anthus",
        arguments={"recipient": "alex@example.com", "body": "hello"},
        creator=AuthorizationIdentity.bot("bot-1"),
    )

    assert recorded is False
    assert plane.refused_bot_auto_review() == [("anthus", "send")]
    assert plane._auto_review_rules == []


def test_human_rule_broader_than_standing_is_refused() -> None:
    plane = ControlPlane()
    plane.set_member_authority_ceiling(
        "anthus",
        "sam@example.com",
        "send",
        arguments={"recipient": "alex@example.com", "body": "weekly update"},
    )

    recorded = plane.add_auto_review_rule(
        AutoReviewRuleKind.ALWAYS_ALLOW,
        "send",
        "anthus",
        arguments={"recipient": "anyone@example.com", "body": "weekly update"},
        creator=AuthorizationIdentity.human("sam@example.com"),
    )

    assert recorded is False
    assert ("anthus", "send", "sam@example.com") in plane.refused_authority_ceiling()
    assert plane._auto_review_rules == []


def test_human_rule_within_standing_is_recorded() -> None:
    plane = ControlPlane()
    plane.set_member_authority_ceiling(
        "anthus",
        "sam@example.com",
        "send",
        arguments={"recipient": "alex@example.com", "body": "weekly update"},
    )

    recorded = plane.add_auto_review_rule(
        AutoReviewRuleKind.ALWAYS_ALLOW,
        "send",
        "anthus",
        arguments={"recipient": "alex@example.com", "body": "weekly update"},
        creator=AuthorizationIdentity.human("sam@example.com"),
    )

    assert recorded is True
    rule = plane._auto_review_rules[-1]
    assert rule.creator == AuthorizationIdentity.human("sam@example.com")


def test_approval_records_approver_identity() -> None:
    plane = ControlPlane()
    proposal = plane.approval_binding.propose_structured_operation(
        "send",
        "alex@example.com",
        "weekly update",
    )
    approver = AuthorizationIdentity.human("sam@example.com")

    approval = plane.approve_structured_operation(
        "anthus",
        proposal,
        approver=approver,
    )

    assert approval is not None
    assert approval.approver == approver


def test_approval_outside_standing_is_refused() -> None:
    plane = ControlPlane()
    plane.set_member_authority_ceiling(
        "anthus",
        "sam@example.com",
        "send",
        arguments={"recipient": "alex@example.com", "body": "weekly update"},
    )
    proposal = plane.approval_binding.propose_structured_operation(
        "send",
        "other@example.com",
        "weekly update",
    )

    approval = plane.approve_structured_operation(
        "anthus",
        proposal,
        approver=AuthorizationIdentity.human("sam@example.com"),
    )

    assert approval is None
    assert ("anthus", "send", "sam@example.com") in plane.refused_authority_ceiling()


def test_approval_within_standing_is_granted() -> None:
    plane = ControlPlane()
    plane.set_member_authority_ceiling(
        "anthus",
        "sam@example.com",
        "send",
        arguments={"recipient": "alex@example.com", "body": "weekly update"},
    )
    proposal = plane.approval_binding.propose_structured_operation(
        "send",
        "alex@example.com",
        "weekly update",
    )

    approval = plane.approve_structured_operation(
        "anthus",
        proposal,
        approver=AuthorizationIdentity.human("sam@example.com"),
    )

    assert approval is not None
    assert approval.operation.destination == "alex@example.com"


def test_structured_bindings_within_ceiling_bindings_accepts_exact_match() -> None:
    ceiling = {"recipient": "alex@example.com", "body": "weekly update"}
    attempted = {"destination": "alex@example.com", "payload": "weekly update"}

    assert structured_bindings_within_ceiling_bindings(attempted, ceiling) is True


def test_structured_bindings_within_ceiling_bindings_rejects_broader_recipient() -> (
    None
):
    ceiling = {"recipient": "alex@example.com", "body": "weekly update"}
    attempted = {"recipient": "anyone@example.com", "body": "weekly update"}

    assert structured_bindings_within_ceiling_bindings(attempted, ceiling) is False


def test_member_authority_ceiling_maps_structured_send_to_grant_fields() -> None:
    member_ceiling = member_authority_ceiling_from_structured_arguments(
        "send",
        {"recipient": "alex@example.com", "body": "weekly update"},
    )
    grant = task_grant_for_structured_arguments(
        "send",
        {"recipient": "alex@example.com", "body": "weekly update"},
    )

    assert grant_exceeds_ceiling(grant, member_ceiling.grant_ceiling) is False
    assert (
        auto_review_rule_exceeds_member_authority_ceiling(
            "send",
            {"recipient": "alex@example.com", "body": "weekly update"},
            member_ceiling,
        )
        is False
    )


def test_structured_operation_exceeds_member_ceiling_when_action_type_differs() -> None:
    member_ceiling = MemberAuthorityCeiling(
        grant_ceiling=Ceiling(
            action_types=frozenset({"send"}),
            origins=frozenset(),
            recipients=frozenset(),
            file_scopes=frozenset(),
            egress_classes=frozenset(),
        ),
    )
    operation = StructuredConsequentialOperation(
        action_type="purchase",
        destination="store.example",
        payload="99.00",
    )

    assert (
        structured_operation_exceeds_member_authority_ceiling(operation, member_ceiling)
        is True
    )


def test_legacy_created_by_string_maps_to_human_kernel_creator() -> None:
    plane = ControlPlane()
    plane.add_auto_review_rule(
        AutoReviewRuleKind.ALWAYS_ALLOW,
        "send",
        "anthus",
        created_by="human",
    )

    rule = plane._auto_review_rules[-1]
    assert rule.creator.kind == ActorKind.HUMAN
    assert rule.created_by == "human"
