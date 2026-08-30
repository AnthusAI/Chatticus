"""Behave steps for immutable consequential approval binding."""

from __future__ import annotations

from behave import given, then, when

from chatticus.approval_binding import (
    DESTINATION_CHANGED,
    PAYLOAD_CHANGED,
    StructuredConsequentialOperation,
)


def _table_args(context: object) -> dict[str, str]:
    table = context.table
    values = {table.headings[0].strip(): table.headings[1].strip()}
    for row in table:
        values[row.cells[0].strip()] = row.cells[1].strip()
    return values


@given('a bot proposes a structured consequential operation "{action_type}" with:')
def given_bot_proposes(context: object, action_type: str) -> None:
    args = _table_args(context)
    context.proposal = context.plane.approval_binding.propose_structured_operation(
        action_type,
        args["destination"],
        args["payload"],
    )


@when("the user approves that operation")
def when_user_approves(context: object) -> None:
    context.approval = context.plane.approval_binding.approve_operation(
        context.proposal
    )


@when(
    "the worker executes the approved operation with "
    'target-system evidence "{evidence}"'
)
def when_worker_executes_approved(context: object, evidence: str) -> None:
    context.last_execution = context.plane.approval_binding.execute_approved_operation(
        context.approval,
        context.proposal.operation,
        evidence,
    )
    context.recorded_completion_evidence = evidence


@when('the worker attempts to execute "{action_type}" with:')
def when_worker_attempts(context: object, action_type: str) -> None:
    args = _table_args(context)
    attempted = StructuredConsequentialOperation(
        action_type=action_type,
        destination=args["destination"],
        payload=args["payload"],
    )
    context.last_execution = context.plane.approval_binding.execute_approved_operation(
        context.approval,
        attempted,
        "smtp-250",
    )


@then("only the reviewed destination and payload may execute")
def then_only_reviewed_executes(context: object) -> None:
    assert context.last_execution.executed is True
    assert context.last_execution.requires_new_approval is False


@then("changing the destination requires a new approval")
def then_destination_change(context: object) -> None:
    assert context.last_execution.executed is False
    assert context.last_execution.reason == DESTINATION_CHANGED
    assert context.last_execution.requires_new_approval is True


@then("changing the payload requires a new approval")
def then_payload_change(context: object) -> None:
    assert context.last_execution.executed is False
    assert context.last_execution.reason == PAYLOAD_CHANGED
    assert context.last_execution.requires_new_approval is True


@then("completion evidence identifies the target-system result")
def then_completion_evidence(context: object) -> None:
    assert context.recorded_completion_evidence == "smtp-250"
