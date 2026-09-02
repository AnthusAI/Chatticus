"""Kernel tests for unattended consequential-action gating."""

from __future__ import annotations

from chatticus.capability_policy import TaskCapabilityGrant
from chatticus.control_plane import ControlPlane
from chatticus.models import AutoReviewRuleKind
from chatticus.overnight_gated import (
    USER_CONTROLLED_COMPLETION_REQUIRED,
    WAITING_FOR_HUMAN,
)


def _send_grant() -> TaskCapabilityGrant:
    return TaskCapabilityGrant(
        tools=frozenset({"send", "purchase"}),
        origins=frozenset(),
        recipients=frozenset({"a@x", "b@x", "store", "store.example"}),
        file_scopes=frozenset(),
        egress_classes=frozenset({"structured_send", "file_transfer"}),
        ingest_classes=frozenset(),
    )


def test_unattended_send_blocks_without_a_narrow_human_rule() -> None:
    plane = ControlPlane()
    plane.set_turn_capability_grant("anthus", "policy-turn", _send_grant())
    result = plane.resolve_unattended_gated_action(
        "send",
        "anthus",
        arguments={"recipient": "a@x", "body": "hi"},
        channel="structured",
    )
    assert result.executed is False
    assert result.turn_status == "blocked"
    assert result.reason == WAITING_FOR_HUMAN


def test_bot_cannot_loosen_overnight_auto_review() -> None:
    plane = ControlPlane()
    plane.set_turn_capability_grant("anthus", "policy-turn", _send_grant())
    plane.add_auto_review_rule(
        AutoReviewRuleKind.ALWAYS_ALLOW,
        "send",
        "anthus",
        arguments={"recipient": "a@x", "body": "hi"},
        created_by="bot",
    )
    assert plane.refused_bot_auto_review() == [("anthus", "send")]
    result = plane.resolve_unattended_gated_action(
        "send",
        "anthus",
        arguments={"recipient": "a@x", "body": "hi"},
        channel="structured",
    )
    assert result.executed is False


def test_human_preauth_matches_exact_arguments_only() -> None:
    plane = ControlPlane()
    plane.set_turn_capability_grant("anthus", "policy-turn", _send_grant())
    plane.add_auto_review_rule(
        AutoReviewRuleKind.ALWAYS_ALLOW,
        "send",
        "anthus",
        arguments={"recipient": "a@x", "body": "hi"},
        created_by="human",
    )
    ok = plane.resolve_unattended_gated_action(
        "send",
        "anthus",
        arguments={"recipient": "a@x", "body": "hi"},
        channel="structured",
        completion_evidence="smtp-250",
    )
    assert ok.executed is True
    assert ok.completion_evidence == "smtp-250"
    changed = plane.resolve_unattended_gated_action(
        "send",
        "anthus",
        arguments={"recipient": "b@x", "body": "hi"},
        channel="structured",
    )
    assert changed.executed is False
    assert changed.reason is not None


def test_browser_purchase_cannot_be_preauthorized_overnight() -> None:
    plane = ControlPlane()
    plane.set_turn_capability_grant("anthus", "policy-turn", _send_grant())
    plane.add_auto_review_rule(
        AutoReviewRuleKind.ALWAYS_ALLOW,
        "purchase",
        "anthus",
        arguments={"destination": "store", "amount": "1"},
        created_by="human",
    )
    result = plane.resolve_unattended_gated_action(
        "purchase",
        "anthus",
        arguments={"destination": "store", "amount": "1"},
        channel="browser",
    )
    assert result.executed is False
    assert result.reason == USER_CONTROLLED_COMPLETION_REQUIRED
    assert result.retried_unattended is False


def test_type_only_always_allow_does_not_run_overnight() -> None:
    plane = ControlPlane()
    plane.set_turn_capability_grant("anthus", "policy-turn", _send_grant())
    plane.add_auto_review_rule(AutoReviewRuleKind.ALWAYS_ALLOW, "send", "anthus")
    result = plane.resolve_unattended_gated_action(
        "send",
        "anthus",
        arguments={"recipient": "a@x", "body": "hi"},
        channel="structured",
    )
    assert result.executed is False
