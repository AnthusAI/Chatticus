"""Kernel tests for immutable consequential approval binding."""

from __future__ import annotations

from chatticus.approval_binding import (
    DESTINATION_CHANGED,
    PAYLOAD_CHANGED,
    ApprovalBindingGate,
    StructuredConsequentialOperation,
)
from chatticus.control_plane import ControlPlane


def test_approved_operation_executes_exact_destination_and_payload() -> None:
    gate = ApprovalBindingGate()
    proposal = gate.propose_structured_operation(
        "send",
        "alex@example.com",
        "hello",
    )
    approval = gate.approve_operation(proposal)
    result = gate.execute_approved_operation(
        approval,
        proposal.operation,
        "smtp-250",
    )
    assert result.executed is True
    assert result.completion_evidence == "smtp-250"
    assert result.requires_new_approval is False


def test_destination_change_requires_new_approval() -> None:
    gate = ApprovalBindingGate()
    proposal = gate.propose_structured_operation(
        "send",
        "alex@example.com",
        "hello",
    )
    approval = gate.approve_operation(proposal)
    changed = StructuredConsequentialOperation(
        action_type="send",
        destination="other@example.com",
        payload="hello",
    )
    result = gate.execute_approved_operation(approval, changed, "smtp-250")
    assert result.executed is False
    assert result.reason == DESTINATION_CHANGED
    assert result.requires_new_approval is True


def test_payload_change_requires_new_approval() -> None:
    gate = ApprovalBindingGate()
    proposal = gate.propose_structured_operation(
        "send",
        "alex@example.com",
        "hello",
    )
    approval = gate.approve_operation(proposal)
    changed = StructuredConsequentialOperation(
        action_type="send",
        destination="alex@example.com",
        payload="goodbye",
    )
    result = gate.execute_approved_operation(approval, changed, "smtp-250")
    assert result.executed is False
    assert result.reason == PAYLOAD_CHANGED
    assert result.requires_new_approval is True


def test_control_plane_exposes_approval_binding_gate() -> None:
    plane = ControlPlane()
    proposal = plane.approval_binding.propose_structured_operation(
        "publish",
        "https://blog.example.com/post",
        "draft-body",
    )
    approval = plane.approval_binding.approve_operation(proposal)
    result = plane.approval_binding.execute_approved_operation(
        approval,
        proposal.operation,
        "cms-201",
    )
    assert result.executed is True
    assert result.completion_evidence == "cms-201"
