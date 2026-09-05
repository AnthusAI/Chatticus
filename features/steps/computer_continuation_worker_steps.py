"""Behave steps for the computer-capable continuation pull worker."""

from __future__ import annotations

import json
import os
from dataclasses import replace
from unittest.mock import MagicMock, patch
from uuid import uuid4

from behave import given, then, when

from chatticus.computer_continuation_driver import prepare_computer_continuation
from chatticus.control_plane import ControlPlane
from chatticus.host_starter import RecordingHostStarter
from chatticus.http.client import HttpTurnClient
from chatticus.models import (
    ComputerWorkerHostNotReady,
    ComputerWorkerRequiresComputerCapability,
    TurnEventKind,
)
from chatticus.worker.computer import ComputerWorker, FakeComputerActionExecutor
from chatticus.worker.lambda_handler import handler


def _sqs_record_for_job(job: object, *, message_id: str) -> dict[str, str]:
    body = json.dumps(
        {
            "job_id": job.job_id,
            "tenant_id": job.tenant_id,
            "turn_id": job.turn_id,
            "bot_id": job.bot_id,
            "user_id": job.user_id,
            "computer_id": job.computer_id,
            "computer_policy": job.computer_policy,
            "required_capabilities": sorted(job.required_capabilities),
        }
    )
    return {
        "messageId": message_id,
        "receiptHandle": "receipt-1",
        "body": body,
    }


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


@when(
    "a second process sharing the store records a host start for tenant "
    '"{tenant_id}" user "{user_id}"'
)
def when_second_process_records_host_start(
    context: object, tenant_id: str, user_id: str
) -> None:
    worker_plane = ControlPlane(messaging_store=context.messaging_store)
    worker_plane.request_computer_host_start(
        tenant_id,
        "host-start-from-second-process",
    )


@when("a second process sharing the store nacks that continuation without a host")
def when_second_process_nacks_continuation(context: object) -> None:
    setup = context.computer_continuation
    worker_plane = ControlPlane(messaging_store=context.messaging_store)
    worker = ComputerWorker(
        worker_plane,
        HttpTurnClient(context.api_client, setup.tenant_id),
    )
    try:
        worker.run_job(setup.continuation_job)
    except ComputerWorkerHostNotReady:
        return
    raise AssertionError("second process did not nack ComputerWorkerHostNotReady")


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


@given("a recording host start driver")
def given_recording_host_start_driver(context: object) -> None:
    context.host_starter = RecordingHostStarter()


@when("the computer queue lambda handler processes that job without a host executor")
def when_computer_lambda_processes_without_host_executor(context: object) -> None:
    setup = context.computer_continuation
    message_id = "computer-queue-msg-1"
    event = {
        "Records": [_sqs_record_for_job(setup.continuation_job, message_id=message_id)]
    }
    host_starter = getattr(context, "host_starter", None)
    env = {
        "CHATTICUS_WORKER_KIND": "computer",
        "CHATTICUS_INVOKE_KEY": "",
        "CHATTICUS_COMPUTER_TURN_QUEUE_URL": "https://sqs.example/computer",
    }
    with (
        patch.dict(os.environ, env, clear=False),
        patch("boto3.client", return_value=MagicMock()),
        patch(
            "chatticus.worker.lambda_handler.plane_from_env",
            lambda: context.plane,
        ),
        patch(
            "chatticus.worker.lambda_handler._front_door_base_url",
            lambda: str(context.api_client.base_url),
        ),
        patch(
            "chatticus.worker.lambda_handler.host_starter_from_env",
            lambda _get_organization=None: host_starter,
        ),
    ):
        context.lambda_result = handler(event, None)
    context.lambda_message_id = message_id


@when(
    "a computer-capable pull worker without a host executor pulls that continuation job"
)
def when_computer_worker_pulls_without_host_executor(context: object) -> None:
    setup = context.computer_continuation
    context.computer_worker_error = None
    host_starter = getattr(context, "host_starter", None)
    worker = ComputerWorker(
        context.plane,
        HttpTurnClient(context.api_client, setup.tenant_id),
        host_starter=host_starter,
    )
    try:
        worker.run_job(setup.continuation_job)
    except ComputerWorkerHostNotReady as exc:
        context.computer_worker_error = exc


@when(
    "two computer-capable pull workers without a host executor pull that continuation concurrently"  # noqa: E501
)
def when_two_computer_workers_pull_concurrently(context: object) -> None:
    import threading

    setup = context.computer_continuation
    host_starter = getattr(context, "host_starter", None)
    errors: list[BaseException] = []
    barrier = threading.Barrier(2)

    def pull() -> None:
        worker = ComputerWorker(
            context.plane,
            HttpTurnClient(context.api_client, setup.tenant_id),
            host_starter=host_starter,
        )
        barrier.wait()
        try:
            worker.run_job(setup.continuation_job)
        except ComputerWorkerHostNotReady:
            pass
        except BaseException as exc:
            errors.append(exc)

    threads = [threading.Thread(target=pull) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert errors == []


@when("the host start lease expires")
def when_host_start_lease_expires(context: object) -> None:
    context.plane.advance_seconds(context.plane.attempt_lease.total_seconds() + 1)
    context.plane.expire_host_start_claims()


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


@then("the handler returns a batch item failure for that message")
def then_handler_returns_batch_item_failure(context: object) -> None:
    result = context.lambda_result
    assert result == {
        "batchItemFailures": [{"itemIdentifier": context.lambda_message_id}]
    }


@then("the host start driver was invoked once")
def then_host_start_driver_invoked_once(context: object) -> None:
    assert len(context.host_starter.invocations) == 1


@then("the host start driver was still invoked only once")
def then_host_start_driver_still_invoked_once(context: object) -> None:
    assert len(context.host_starter.invocations) == 1


@then("the host start driver was invoked twice")
def then_host_start_driver_invoked_twice(context: object) -> None:
    assert len(context.host_starter.invocations) == 2


@then("the household computer has recorded one host start")
def then_one_host_start_recorded(context: object) -> None:
    setup = context.computer_continuation
    computer = context.plane.computer_for_organization(setup.tenant_id)
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
