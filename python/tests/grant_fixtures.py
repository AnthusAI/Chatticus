"""Shared task capability grants for kernel and adversarial eval tests."""

from __future__ import annotations

from chatticus.capability_policy import TaskCapabilityGrant


def research_grant() -> TaskCapabilityGrant:
    """Read-only research browsing on one origin and workspace prefix."""
    return TaskCapabilityGrant(
        tools=frozenset({"browse", "read_workspace"}),
        origins=frozenset({"https://docs.example.com"}),
        recipients=frozenset(),
        file_scopes=frozenset({"/workspace/research"}),
        egress_classes=frozenset({"approved_origin_fetch"}),
    )


def send_grant() -> TaskCapabilityGrant:
    """Structured send to one granted recipient."""
    return TaskCapabilityGrant(
        tools=frozenset({"send"}),
        origins=frozenset(),
        recipients=frozenset({"a@x"}),
        file_scopes=frozenset(),
        egress_classes=frozenset({"structured_send"}),
    )


def exact_approval_send_grant() -> TaskCapabilityGrant:
    """Structured send for immutable approval binding cases."""
    return TaskCapabilityGrant(
        tools=frozenset({"send"}),
        origins=frozenset(),
        recipients=frozenset({"alex@example.com", "other@example.com"}),
        file_scopes=frozenset(),
        egress_classes=frozenset({"structured_send"}),
    )
