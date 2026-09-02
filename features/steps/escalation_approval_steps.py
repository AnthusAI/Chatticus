"""Behave steps for approval escalation when standing is insufficient."""

from __future__ import annotations

from behave import given, then, when
from behave.exception import StepNotImplementedError


def _table_args(context: object) -> dict[str, str]:
    table = context.table
    values = {table.headings[0].strip(): table.headings[1].strip()}
    for row in table:
        values[row.cells[0].strip()] = row.cells[1].strip()
    return values


def _pending_behavior(step_name: str) -> None:
    raise StepNotImplementedError(
        f"Approval escalation behavior is not implemented yet: {step_name}"
    )


@given(
    'a bot on behalf of "{requester}" proposes structured consequential operation '
    '"{action_type}" with:'
)
def given_bot_proposes_on_behalf(
    context: object, requester: str, action_type: str
) -> None:
    args = _table_args(context)
    context.escalation_approval_requester = requester
    context.proposal = context.plane.approval_binding.propose_structured_operation(
        action_type,
        args["destination"],
        args["payload"],
    )


@when("the consequential operation is routed for approval")
def when_operation_routed_for_approval(context: object) -> None:
    _pending_behavior("route consequential operation for approval")


@then('the approval request escalates to "{email}"')
def then_approval_escalates_to(context: object, email: str) -> None:
    context.escalation_approval_target = email
    _pending_behavior("escalate approval to nearest covering member")


@then("no organization member ceiling covers the operation")
def then_no_member_ceiling_covers(context: object) -> None:
    _pending_behavior("detect uncovered consequential operation")


@then("the turn waits for a member with sufficient standing")
def then_turn_waits_for_sufficient_standing(context: object) -> None:
    _pending_behavior("block turn until sufficient standing is available")
