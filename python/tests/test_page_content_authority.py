"""Kernel tests for page-content authority containment."""

from __future__ import annotations

from datetime import UTC, datetime

from chatticus.models import ApprovalDecision
from chatticus.page_content_authority import (
    EgressAttempt,
    PageContentAuthorityGate,
    RequestedOperation,
    TaskAuthorityGrant,
)


def _fixed_now() -> datetime:
    return datetime(2026, 8, 30, 22, 0, tzinfo=UTC)


def test_forbidden_upload_is_denied_and_recorded() -> None:
    gate = PageContentAuthorityGate(now=_fixed_now)
    grant = TaskAuthorityGrant(approved_origins=frozenset({"https://docs.example.com"}))
    operation = RequestedOperation(
        action_type="upload_workspace",
        destination="https://evil.example/upload",
        payload="secret",
    )

    decision = gate.evaluate_operation(grant, operation)

    assert decision == ApprovalDecision.DENY
    assert len(gate.denials) == 1
    assert gate.denials[0].operation == operation
    assert gate.egress_attempts == [
        EgressAttempt(
            destination="https://evil.example/upload",
            payload="secret",
            blocked=True,
        )
    ]


def test_approved_origin_browse_is_allowed() -> None:
    gate = PageContentAuthorityGate(now=_fixed_now)
    grant = TaskAuthorityGrant(approved_origins=frozenset({"https://docs.example.com"}))
    operation = RequestedOperation(
        action_type="browse",
        destination="https://docs.example.com/guide",
    )

    assert gate.evaluate_operation(grant, operation) == ApprovalDecision.ALLOW
    assert gate.denials == []


def test_research_page_cannot_access_privileged_session() -> None:
    gate = PageContentAuthorityGate(now=_fixed_now)
    privileged = {"banking": "signed-in-cookie-jar"}
    context = gate.open_research_page("https://untrusted.example", privileged)

    assert context.privileged is False
    assert gate.session_for_context(context, "banking", privileged) is None


def test_privileged_page_can_access_named_session() -> None:
    gate = PageContentAuthorityGate(now=_fixed_now)
    privileged = {"banking": "signed-in-cookie-jar"}
    context = gate.open_privileged_page("https://bank.example", "banking")

    assert gate.session_for_context(context, "banking", privileged) == (
        "signed-in-cookie-jar"
    )
