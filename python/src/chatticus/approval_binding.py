"""Bind human approval to one immutable consequential operation.

When a user approves a structured operation, only the exact destination
and payload they reviewed may execute. A model cannot substitute a
different target after approval. Completion evidence comes from the
target system, not from the agent.
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import uuid4

from chatticus.models import CONSEQUENTIAL_ACTION_TYPES

DESTINATION_CHANGED = "destination_changed"
PAYLOAD_CHANGED = "payload_changed"
NOT_APPROVED = "not_approved"


@dataclass(frozen=True)
class StructuredConsequentialOperation:
    """One structured consequential action with concrete destination and payload."""

    action_type: str
    destination: str
    payload: str


@dataclass(frozen=True)
class OperationProposal:
    """A bot-proposed operation awaiting human review."""

    proposal_id: str
    operation: StructuredConsequentialOperation


@dataclass(frozen=True)
class ApprovedOperation:
    """Human approval bound to exactly one reviewed operation."""

    approval_id: str
    operation: StructuredConsequentialOperation


@dataclass(frozen=True)
class BoundExecutionResult:
    """Outcome of executing against an approved binding."""

    executed: bool
    reason: str | None
    completion_evidence: str | None
    requires_new_approval: bool = False


class ApprovalBindingGate:
    """Propose, approve, and execute one immutable consequential operation."""

    def __init__(self) -> None:
        self._proposals: dict[str, StructuredConsequentialOperation] = {}
        self._approvals: dict[str, StructuredConsequentialOperation] = {}
        self._last_execution: BoundExecutionResult | None = None

    @property
    def last_execution(self) -> BoundExecutionResult | None:
        """Return the most recent execution attempt."""
        return self._last_execution

    def propose_structured_operation(
        self,
        action_type: str,
        destination: str,
        payload: str,
    ) -> OperationProposal:
        """Record a bot proposal with concrete destination and payload."""
        if action_type not in CONSEQUENTIAL_ACTION_TYPES:
            msg = f"Action type {action_type!r} is not consequential."
            raise ValueError(msg)
        operation = StructuredConsequentialOperation(
            action_type=action_type,
            destination=destination,
            payload=payload,
        )
        proposal_id = uuid4().hex
        self._proposals[proposal_id] = operation
        return OperationProposal(proposal_id=proposal_id, operation=operation)

    def approve_operation(self, proposal: OperationProposal) -> ApprovedOperation:
        """Bind human approval to the reviewed proposal."""
        stored = self._proposals.get(proposal.proposal_id)
        if stored is None or stored != proposal.operation:
            raise ValueError(f"Unknown or stale proposal {proposal.proposal_id!r}.")
        approval_id = uuid4().hex
        self._approvals[approval_id] = stored
        return ApprovedOperation(approval_id=approval_id, operation=stored)

    def execute_approved_operation(
        self,
        approval: ApprovedOperation,
        attempted: StructuredConsequentialOperation,
        completion_evidence: str,
    ) -> BoundExecutionResult:
        """Execute only when the attempt matches the approved binding."""
        bound = self._approvals.get(approval.approval_id)
        if bound is None or bound != approval.operation:
            result = BoundExecutionResult(
                executed=False,
                reason=NOT_APPROVED,
                completion_evidence=None,
                requires_new_approval=True,
            )
            self._last_execution = result
            return result
        if attempted.action_type != bound.action_type:
            result = BoundExecutionResult(
                executed=False,
                reason=NOT_APPROVED,
                completion_evidence=None,
                requires_new_approval=True,
            )
            self._last_execution = result
            return result
        if attempted.destination != bound.destination:
            result = BoundExecutionResult(
                executed=False,
                reason=DESTINATION_CHANGED,
                completion_evidence=None,
                requires_new_approval=True,
            )
            self._last_execution = result
            return result
        if attempted.payload != bound.payload:
            result = BoundExecutionResult(
                executed=False,
                reason=PAYLOAD_CHANGED,
                completion_evidence=None,
                requires_new_approval=True,
            )
            self._last_execution = result
            return result
        result = BoundExecutionResult(
            executed=True,
            reason=None,
            completion_evidence=completion_evidence,
        )
        self._last_execution = result
        return result
