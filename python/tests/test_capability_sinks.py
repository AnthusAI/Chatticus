"""Tests for capability sink adapters."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from grant_fixtures import research_grant, send_grant

from chatticus.authorization_ceiling import MemberStanding
from chatticus.capability_sinks import (
    CapabilitySinkDenied,
    attempt_authenticated_browser_action_at_sink,
    gated_read_workspace,
    resolve_unattended_gated_action_at_sink,
)
from chatticus.control_plane import ControlPlane
from chatticus.models import AutoReviewRuleKind
from chatticus.overnight_gated import (
    USER_CONTROLLED_COMPLETION_REQUIRED,
    WAITING_FOR_HUMAN,
)


def _now() -> datetime:
    return datetime(2026, 8, 31, 20, 0, tzinfo=UTC)


_OWNER_STANDING = MemberStanding.owner()


def test_gated_read_workspace_denies_ungranted_path() -> None:
    plane = ControlPlane()
    plane.set_turn_capability_grant("anthus", "turn-1", research_grant())
    with pytest.raises(CapabilitySinkDenied):
        gated_read_workspace(
            plane.capability_policy_for("anthus", "turn-1"),
            "/workspace/secrets/notes.txt",
            _OWNER_STANDING,
        )


def test_gated_read_workspace_allows_granted_path() -> None:
    plane = ControlPlane()
    plane.set_turn_capability_grant("anthus", "turn-1", research_grant())
    gated_read_workspace(
        plane.capability_policy_for("anthus", "turn-1"),
        "/workspace/research/notes.txt",
        _OWNER_STANDING,
    )


def test_plane_gated_read_returns_content() -> None:
    plane = ControlPlane()
    plane.ensure_computer("anthus")
    plane.write_workspace("anthus", "/workspace/research/notes.txt", "weekly")
    plane.set_turn_capability_grant("anthus", "turn-1", research_grant())
    assert (
        plane.gated_read_workspace("anthus", "turn-1", "/workspace/research/notes.txt")
        == "weekly"
    )


def test_plane_gated_read_denies_without_grant() -> None:
    plane = ControlPlane()
    plane.ensure_computer("anthus")
    plane.write_workspace("anthus", "/workspace/research/notes.txt", "weekly")
    with pytest.raises(CapabilitySinkDenied):
        plane.gated_read_workspace("anthus", "turn-1", "/workspace/research/notes.txt")


def test_unattended_send_blocks_without_grant() -> None:
    plane = ControlPlane()
    result = plane.resolve_unattended_gated_action(
        "send",
        "anthus",
        arguments={"recipient": "a@x", "body": "hi"},
        channel="structured",
    )
    assert result.executed is False
    assert result.reason == "no task grant"


def test_unattended_send_blocks_without_human_rule() -> None:
    plane = ControlPlane()
    plane.set_turn_capability_grant("anthus", "policy-turn", send_grant())
    result = plane.resolve_unattended_gated_action(
        "send",
        "anthus",
        arguments={"recipient": "a@x", "body": "hi"},
        channel="structured",
    )
    assert result.executed is False
    assert result.reason == WAITING_FOR_HUMAN


def test_unbound_browser_action_uses_policy_binding() -> None:
    plane = ControlPlane()
    policy = plane.capability_policy_for("policy-tenant", "policy-turn")
    result = attempt_authenticated_browser_action_at_sink(policy, "send")
    assert result.executed is False
    assert result.reason == USER_CONTROLLED_COMPLETION_REQUIRED
    assert policy.last_binding is not None
    assert policy.last_binding.value == "unbound_stop"


def test_human_preauth_still_requires_grant() -> None:
    plane = ControlPlane()
    plane.add_auto_review_rule(
        AutoReviewRuleKind.ALWAYS_ALLOW,
        "send",
        "anthus",
        arguments={"recipient": "a@x", "body": "hi"},
        created_by="human",
    )
    result = resolve_unattended_gated_action_at_sink(
        plane.capability_policy_for("anthus", "policy-turn"),
        action_type="send",
        arguments={"recipient": "a@x", "body": "hi"},
        channel="structured",
        rules=plane._auto_review_rules,
        tenant_id="anthus",
        member_standing=_OWNER_STANDING,
    )
    assert result.executed is False
    assert result.reason == "no task grant"
