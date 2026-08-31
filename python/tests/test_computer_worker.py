"""Kernel tests for the computer-capable continuation pull worker."""

from __future__ import annotations

import pytest

from chatticus.computer_continuation_driver import prepare_computer_continuation
from chatticus.control_plane import ControlPlane
from chatticus.http.app import create_app
from chatticus.http.client import HttpTurnClient
from chatticus.http.test_server import start_test_server
from chatticus.models import (
    ComputerlessCannotExecuteComputerJob,
    ComputerWorkerRequiresComputerCapability,
    TurnEventKind,
    TurnJob,
)
from chatticus.structured_handoff_driver import StructuredHandoffDriver
from chatticus.worker.computer import ComputerWorker, FakeComputerActionExecutor
from chatticus.worker.computerless import (
    ComputerlessWorker,
    FakeTextCompletionClient,
)


def _client_for(plane: ControlPlane):
    return start_test_server(create_app(plane))


def test_computer_worker_executes_unresolved_tool_call_from_journal() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    setup = prepare_computer_continuation(plane)
    ComputerWorker(
        plane,
        HttpTurnClient(api, setup.tenant_id),
    ).run_job(setup.continuation_job)
    record = plane.escalation_for(setup.tenant_id, setup.turn_id)
    assert record.executed_action_id == setup.pending_action_id
    assert record.result_body == "opened"
    assert plane.unresolved_tool_action_ids(setup.tenant_id, setup.turn_id) == []
    remaining = [
        job for job in plane._jobs if job.job_id == setup.continuation_job.job_id
    ]
    assert remaining == []
    events = plane.list_turn_events(setup.tenant_id, setup.turn_id)
    assert any(
        event.kind == TurnEventKind.TOOL_RESULT
        and event.action_id == setup.pending_action_id
        for event in events
    )
    api.close()


def test_computer_worker_refuses_a_cpu_only_job() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    setup = prepare_computer_continuation(plane)
    cpu_job = TurnJob(
        job_id="cpu-only",
        tenant_id=setup.tenant_id,
        required_capabilities=frozenset({"cpu"}),
        turn_id=setup.turn_id,
        bot_id=setup.continuation_job.bot_id,
        user_id=setup.user_id,
    )
    worker = ComputerWorker(plane, HttpTurnClient(api, setup.tenant_id))
    with pytest.raises(ComputerWorkerRequiresComputerCapability):
        worker.run_job(cpu_job)
    remaining = [
        job for job in plane._jobs if job.job_id == setup.continuation_job.job_id
    ]
    assert len(remaining) == 1
    api.close()


def test_computer_worker_reclaims_after_lease_expiry_without_scheduler() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    setup = prepare_computer_continuation(plane)
    worker_id = setup.continuation_job.job_id
    claimed = plane.claim_turn_attempt(setup.tenant_id, setup.turn_id, worker_id)
    assert claimed is not None and claimed.acquired
    plane.record_attempt_claimed(setup.tenant_id, setup.turn_id)
    assert plane.claim_computer_for_turn(setup.tenant_id, setup.turn_id, worker_id)
    plane.execute_pending_computer_action(setup.tenant_id, setup.turn_id)
    plane.advance_seconds(plane.attempt_lease.total_seconds() + 1)
    plane.expire_orphaned_computer_claims()
    ComputerWorker(
        plane,
        HttpTurnClient(api, setup.tenant_id),
    ).run_job(setup.continuation_job)
    record = plane.escalation_for(setup.tenant_id, setup.turn_id)
    assert record.computer_action_count == 1
    assert record.result_committed is True
    assert plane.unresolved_tool_action_ids(setup.tenant_id, setup.turn_id) == []
    api.close()


def test_computer_worker_continues_structured_handoff_journal() -> None:
    driver = StructuredHandoffDriver()
    driver.given_ready_to_request_computer_tool()
    assert driver.turn_id is not None
    driver.plane.record_model_request(driver.tenant_id, driver.turn_id, "open mail")
    driver.plane.commit_pending_computer_tool(driver.tenant_id, driver.turn_id)
    driver.plane.enqueue_computer_continuation(driver.tenant_id, driver.turn_id)
    driver.plane.relinquish_computerless_ownership(driver.tenant_id, driver.turn_id)
    driver.plane.set_computer_stopped(driver.tenant_id, driver.user_id, False)
    record = driver.plane.escalation_for(driver.tenant_id, driver.turn_id)
    assert record.continuation_job_id is not None
    job = next(
        job for job in driver.plane._jobs if job.job_id == record.continuation_job_id
    )
    api = _client_for(driver.plane)
    ComputerWorker(
        driver.plane,
        HttpTurnClient(api, driver.tenant_id),
        action_executor=FakeComputerActionExecutor(),
    ).run_job(job)
    record = driver.plane.escalation_for(driver.tenant_id, driver.turn_id)
    assert record.result_committed is True
    assert (
        driver.plane.unresolved_tool_action_ids(driver.tenant_id, driver.turn_id) == []
    )
    api.close()


def test_computerless_and_computer_workers_partition_jobs() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    setup = prepare_computer_continuation(plane)
    turn_client = HttpTurnClient(api, setup.tenant_id)
    with pytest.raises(ComputerlessCannotExecuteComputerJob):
        ComputerlessWorker(plane, turn_client, FakeTextCompletionClient()).run_job(
            setup.continuation_job
        )
    with pytest.raises(ComputerWorkerRequiresComputerCapability):
        ComputerWorker(plane, turn_client).run_job(
            TurnJob(
                job_id="cpu",
                tenant_id=setup.tenant_id,
                required_capabilities=frozenset({"cpu"}),
                turn_id=setup.turn_id,
                bot_id=setup.continuation_job.bot_id,
                user_id=setup.user_id,
            )
        )
    remaining = [
        job for job in plane._jobs if job.job_id == setup.continuation_job.job_id
    ]
    assert len(remaining) == 1
    api.close()
