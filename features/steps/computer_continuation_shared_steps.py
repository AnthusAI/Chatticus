"""Behave steps the host-side computer features share: a queued continuation job."""

from __future__ import annotations

from behave import given, then

from chatticus.computer_continuation_driver import prepare_computer_continuation
from chatticus.models import TurnEventKind


@given("a fenced computer handoff with a queued continuation job")
def given_fenced_handoff_with_continuation(context: object) -> None:
    context.computer_continuation = prepare_computer_continuation(context.plane)
    context.continuation_job = context.computer_continuation.continuation_job


@then("the turn journal records tool.result for the pending action id")
def then_journal_records_tool_result(context: object) -> None:
    setup = context.computer_continuation
    events = context.plane.list_turn_events(setup.tenant_id, setup.turn_id)
    results = [
        event
        for event in events
        if event.kind == TurnEventKind.TOOL_RESULT
        and event.action_id == setup.pending_action_id
    ]
    assert len(results) == 1
    assert results[0].body == "opened"


@then("the pull worker leaves no unresolved tool calls")
def then_pull_worker_leaves_no_unresolved_tool_calls(context: object) -> None:
    setup = context.computer_continuation
    assert (
        context.plane.unresolved_tool_action_ids(setup.tenant_id, setup.turn_id) == []
    )


@then("the computer continuation job is removed from the queue")
def then_computer_continuation_job_removed(context: object) -> None:
    setup = context.computer_continuation
    remaining = [
        job
        for job in context.plane._jobs
        if job.job_id == setup.continuation_job.job_id
    ]
    assert remaining == []
