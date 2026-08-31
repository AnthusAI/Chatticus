"""Behave steps for the computer-capable continuation pull worker."""

from __future__ import annotations

from dataclasses import replace
from uuid import uuid4

from behave import given, then, when

from chatticus.computer_continuation_driver import prepare_computer_continuation
from chatticus.http.client import HttpTurnClient
from chatticus.models import (
    ComputerWorkerHostNotReady,
    ComputerWorkerRequiresComputerCapability,
    TurnEventKind,
)
from chatticus.worker.computer import ComputerWorker, FakeComputerActionExecutor


@given("a fenced computer handoff with a queued continuation job")
def given_fenced_handoff_with_continuation(context: object) -> None:
    context.computer_continuation = prepare_computer_continuation(context.plane)
    context.continuation_job = context.computer_continuation.continuation_job


@given("the pending computer action ran before its lease expired")
def given_action_ran_before_lease_expired(context: object) -> None:
    setup = context.computer_continuation
    worker_id = setup.continuation_job.job_id
    claimed = context.plane.claim_turn_attempt(
        setup.tenant_id, setup.turn_id, worker_id
    )
    assert claimed is not None and claimed.acquired
    context.plane.record_attempt_claimed(setup.tenant_id, setup.turn_id)
    assert context.plane.claim_computer_for_turn(
        setup.tenant_id, setup.turn_id, worker_id
    )
    context.plane.execute_pending_computer_action(setup.tenant_id, setup.turn_id)
    context.plane.advance_seconds(context.plane.attempt_lease.total_seconds() + 1)
    context.plane.expire_orphaned_computer_claims()


@when("a computer-capable worker pulls that continuation job")
def when_computer_worker_pulls_continuation(context: object) -> None:
    setup = context.computer_continuation
    context.computer_worker_error = None
    worker = ComputerWorker(
        context.plane,
        HttpTurnClient(context.api_client, setup.tenant_id),
        action_executor=FakeComputerActionExecutor(),
    )
    try:
        worker.run_job(setup.continuation_job)
    except ComputerWorkerRequiresComputerCapability as exc:
        context.computer_worker_error = exc


@when("a computer-capable worker pulls that continuation job after the lease dies")
def when_computer_worker_pulls_after_lease_dies(context: object) -> None:
    when_computer_worker_pulls_continuation(context)


@when("a computer-capable worker is given a cpu-only job for that turn")
def when_computer_worker_given_cpu_job(context: object) -> None:
    setup = context.computer_continuation
    cpu_job = replace(
        setup.continuation_job,
        job_id=str(uuid4()),
        required_capabilities=frozenset({"cpu"}),
    )
    context.computer_worker_error = None
    worker = ComputerWorker(
        context.plane,
        HttpTurnClient(context.api_client, setup.tenant_id),
        action_executor=FakeComputerActionExecutor(),
    )
    try:
        worker.run_job(cpu_job)
    except ComputerWorkerRequiresComputerCapability as exc:
        context.computer_worker_error = exc


@when(
    "a computer-capable pull worker without a host executor pulls that continuation job"
)
def when_computer_worker_pulls_without_host_executor(context: object) -> None:
    setup = context.computer_continuation
    context.computer_worker_error = None
    worker = ComputerWorker(
        context.plane,
        HttpTurnClient(context.api_client, setup.tenant_id),
    )
    try:
        worker.run_job(setup.continuation_job)
    except ComputerWorkerHostNotReady as exc:
        context.computer_worker_error = exc


@then("no tool result is committed for the pending action")
def then_no_tool_result_committed(context: object) -> None:
    setup = context.computer_continuation
    events = context.plane.list_turn_events(setup.tenant_id, setup.turn_id)
    results = [
        event
        for event in events
        if event.kind == TurnEventKind.TOOL_RESULT
        and event.action_id == setup.pending_action_id
    ]
    assert results == []
    record = context.plane.escalation_for(setup.tenant_id, setup.turn_id)
    assert record.result_committed is False


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


@then("the computer continuation job remains queued")
def then_computer_continuation_job_remains_queued(context: object) -> None:
    setup = context.computer_continuation
    remaining = [
        job
        for job in context.plane._jobs
        if job.job_id == setup.continuation_job.job_id
    ]
    assert len(remaining) == 1
    assert "computer" in remaining[0].required_capabilities


@then("the household computer has recorded one host start")
def then_one_host_start_recorded(context: object) -> None:
    setup = context.computer_continuation
    computer = context.plane.computer_for_user(setup.tenant_id, setup.user_id)
    assert computer.host_start_generation == 1


@then("the computer-capable worker refuses the cpu job")
def then_computer_worker_refuses_cpu_job(context: object) -> None:
    assert isinstance(
        context.computer_worker_error, ComputerWorkerRequiresComputerCapability
    )


@then("the computer was reclaimed by the pull worker")
def then_computer_reclaimed_by_pull_worker(context: object) -> None:
    setup = context.computer_continuation
    record = context.plane.escalation_for(setup.tenant_id, setup.turn_id)
    assert record.result_committed is True
    assert record.computer_action_count == 1


@then("the tool result is committed once")
def then_tool_result_committed_once(context: object) -> None:
    setup = context.computer_continuation
    record = context.plane.escalation_for(setup.tenant_id, setup.turn_id)
    assert record.result_body == "opened"
    assert record.computer_action_count == 1
