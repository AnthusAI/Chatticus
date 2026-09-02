"""Kernel tests for the computer-capable continuation pull worker."""

from __future__ import annotations

import pytest
from computer_worker_helpers import CountingComputerActionExecutor
from http_test_support import start_authed_test_server

from chatticus.browser_waiting_continuation_driver import (
    prepare_browser_waiting_continuation,
)
from chatticus.capability_policy import EgressClass, TaskCapabilityGrant
from chatticus.computer_capabilities import BROWSER_CAPABILITY
from chatticus.computer_continuation_driver import prepare_computer_continuation
from chatticus.control_plane import ControlPlane
from chatticus.host_starter import RecordingHostStarter
from chatticus.http.client import HttpTurnClient
from chatticus.http.paths import org_path
from chatticus.messaging.store import InMemoryMessagingStore
from chatticus.models import (
    ActorKind,
    ComputerlessCannotExecuteComputerJob,
    ComputerWorkerHostNotReady,
    ComputerWorkerRequiresComputerCapability,
    CostClass,
    TurnEventKind,
    TurnJob,
    WorkerRegistration,
)
from chatticus.structured_handoff_driver import StructuredHandoffDriver
from chatticus.worker.computer import ComputerWorker, FakeComputerActionExecutor
from chatticus.worker.computerless import (
    ComputerlessWorker,
    FakeTextCompletionClient,
)


def _client_for(plane: ControlPlane):
    return start_authed_test_server(plane, invoke_key="")


def test_computer_worker_executes_unresolved_tool_call_from_journal() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    setup = prepare_computer_continuation(plane)
    ComputerWorker(
        plane,
        HttpTurnClient(api, setup.tenant_id),
        action_executor=FakeComputerActionExecutor(),
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


def test_computer_worker_leaves_job_queued_without_host_executor() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    setup = prepare_computer_continuation(plane)
    with pytest.raises(ComputerWorkerHostNotReady):
        ComputerWorker(
            plane,
            HttpTurnClient(api, setup.tenant_id),
        ).run_job(setup.continuation_job)
    record = plane.escalation_for(setup.tenant_id, setup.turn_id)
    assert record.result_committed is False
    assert plane.unresolved_tool_action_ids(setup.tenant_id, setup.turn_id) != []
    remaining = [
        job for job in plane._jobs if job.job_id == setup.continuation_job.job_id
    ]
    assert len(remaining) == 1
    assert (
        plane.computer_for_user(setup.tenant_id, setup.user_id).host_start_generation
        == 1
    )
    with pytest.raises(ComputerWorkerHostNotReady):
        ComputerWorker(
            plane,
            HttpTurnClient(api, setup.tenant_id),
        ).run_job(setup.continuation_job)
    assert (
        plane.computer_for_user(setup.tenant_id, setup.user_id).host_start_generation
        == 1
    )
    api.close()


def test_computer_worker_nacks_host_not_ready_on_a_second_process() -> None:
    store = InMemoryMessagingStore()
    door = ControlPlane(messaging_store=store)
    api = _client_for(door)
    setup = prepare_computer_continuation(door)
    worker_plane = ControlPlane(messaging_store=store)
    with pytest.raises(ComputerWorkerHostNotReady):
        ComputerWorker(
            worker_plane,
            HttpTurnClient(api, setup.tenant_id),
        ).run_job(setup.continuation_job)
    assert (
        door.computer_for_user(setup.tenant_id, setup.user_id).host_start_generation
        == 1
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
        action_executor=FakeComputerActionExecutor(),
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
    driver.plane.record_computer_capability_ready(
        driver.tenant_id, driver.user_id, BROWSER_CAPABILITY
    )
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


def test_computer_worker_invokes_host_starter_once_per_lease() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    setup = prepare_computer_continuation(plane)
    starter = RecordingHostStarter()
    worker = ComputerWorker(
        plane,
        HttpTurnClient(api, setup.tenant_id),
        host_starter=starter,
    )
    with pytest.raises(ComputerWorkerHostNotReady):
        worker.run_job(setup.continuation_job)
    assert len(starter.invocations) == 1
    assert starter.invocations[0].host_start_count == 1
    with pytest.raises(ComputerWorkerHostNotReady):
        worker.run_job(setup.continuation_job)
    assert len(starter.invocations) == 1
    api.close()


def test_computer_worker_invokes_host_starter_again_after_lease_expiry() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    setup = prepare_computer_continuation(plane)
    starter = RecordingHostStarter()
    worker = ComputerWorker(
        plane,
        HttpTurnClient(api, setup.tenant_id),
        host_starter=starter,
    )
    with pytest.raises(ComputerWorkerHostNotReady):
        worker.run_job(setup.continuation_job)
    plane.advance_seconds(plane.attempt_lease.total_seconds() + 1)
    plane.expire_host_start_claims()
    with pytest.raises(ComputerWorkerHostNotReady):
        worker.run_job(setup.continuation_job)
    assert len(starter.invocations) == 2
    assert [claim.host_start_count for claim in starter.invocations] == [1, 2]
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


def test_computer_worker_nacks_when_host_starter_fails() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    setup = prepare_computer_continuation(plane)

    class RaisingHostStarter:
        def start_host(self, claim: object) -> None:
            raise RuntimeError("ecs:TagResource denied")

    worker = ComputerWorker(
        plane,
        HttpTurnClient(api, setup.tenant_id),
        host_starter=RaisingHostStarter(),
    )
    with pytest.raises(ComputerWorkerHostNotReady, match="host start failed"):
        worker.run_job(setup.continuation_job)
    with pytest.raises(ComputerWorkerHostNotReady, match="host start failed"):
        worker.run_job(setup.continuation_job)
    api.close()


def test_concurrent_computer_workers_start_host_once() -> None:
    import threading

    plane = ControlPlane()
    api = _client_for(plane)
    setup = prepare_computer_continuation(plane)
    starter = RecordingHostStarter()
    errors: list[BaseException] = []
    barrier = threading.Barrier(2)

    def pull() -> None:
        worker = ComputerWorker(
            plane,
            HttpTurnClient(api, setup.tenant_id),
            host_starter=starter,
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
    assert len(starter.invocations) == 1
    api.close()


def test_computer_worker_hydrates_waiting_turn_after_process_recycle() -> None:
    store = InMemoryMessagingStore()
    plane = ControlPlane(messaging_store=store)
    api = _client_for(plane)
    bot = plane.create_bot("anthus", "ryan", "Researcher")
    channel = plane.create_channel("anthus", "ryan", [bot.bot_id])
    post = api.post(
        org_path(channel.tenant_id, f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "open the household browser",
            "addressed_to_bot_id": bot.bot_id,
        },
    )
    turn_id = post.json()["turn_id"]
    client = HttpTurnClient(api, channel.tenant_id)
    client.claim(turn_id, "waiting-worker")
    client.post_waiting(turn_id, "browser")
    plane.set_computer_stopped("anthus", "ryan", False)
    plane.record_computer_capability_ready("anthus", "ryan", BROWSER_CAPABILITY)
    job = plane.resume_waiting_turn(channel.tenant_id, turn_id)
    api.close()

    recycled = ControlPlane(messaging_store=store)
    api = _client_for(recycled)
    ComputerWorker(
        recycled,
        HttpTurnClient(api, channel.tenant_id),
        action_executor=FakeComputerActionExecutor(),
    ).run_job(job)
    record = recycled.escalation_for(channel.tenant_id, turn_id)
    assert record.result_committed is True
    assert recycled.unresolved_tool_action_ids(channel.tenant_id, turn_id) == []
    finished = recycled.turn(channel.tenant_id, turn_id)
    assert finished.waiting_for is None
    api.close()


def test_concurrent_browser_waiting_workers_commit_tool_result_once() -> None:
    import threading

    plane = ControlPlane()
    api = _client_for(plane)
    setup = prepare_browser_waiting_continuation(plane)
    worker_token = plane.register_worker(
        WorkerRegistration(
            worker_id=setup.continuation_job.job_id,
            tenant_id=setup.tenant_id,
            cost_class=CostClass.LOCAL,
            capabilities=frozenset({"computer", "browser"}),
        )
    )
    executor = CountingComputerActionExecutor()
    duplicate_job = setup.continuation_job
    errors: list[BaseException] = []
    barrier = threading.Barrier(2)

    def pull() -> None:
        worker = ComputerWorker(
            plane,
            HttpTurnClient(
                api,
                setup.tenant_id,
                worker_token=worker_token,
                worker_id=duplicate_job.job_id,
            ),
            action_executor=executor,
        )
        barrier.wait()
        try:
            worker.run_job(duplicate_job)
        except BaseException as exc:
            errors.append(exc)

    threads = [threading.Thread(target=pull) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert errors == []
    assert executor.calls == 1
    events = plane.list_turn_events(setup.tenant_id, setup.turn_id)
    results = [
        event
        for event in events
        if event.kind == TurnEventKind.TOOL_RESULT
        and event.action_id == setup.pending_action_id
    ]
    assert len(results) == 1
    assert results[0].body == "opened"
    assert plane.unresolved_tool_action_ids(setup.tenant_id, setup.turn_id) == []
    remaining = [
        job for job in plane._jobs if job.job_id == setup.continuation_job.job_id
    ]
    assert remaining == []
    api.close()


def test_computer_worker_passes_active_browser_storage_partition() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    setup = prepare_computer_continuation(plane)
    plane.set_turn_capability_grant(
        setup.tenant_id,
        setup.turn_id,
        TaskCapabilityGrant(
            tools=frozenset({"browse"}),
            origins=frozenset({"https://bank.example", "https://mail.example"}),
            recipients=frozenset(),
            file_scopes=frozenset(),
            egress_classes=frozenset({EgressClass.APPROVED_ORIGIN_FETCH.value}),
        ),
    )
    plane.open_privileged_browser_context(
        setup.tenant_id,
        setup.turn_id,
        "https://bank.example/app",
        "banking",
    )
    executor = CountingComputerActionExecutor()
    ComputerWorker(
        plane,
        HttpTurnClient(api, setup.tenant_id),
        action_executor=executor,
    ).run_job(setup.continuation_job)
    assert executor.last_arguments is not None
    assert executor.last_arguments["storage_partition"] == "privileged:banking"
    api.close()


def test_computer_worker_defaults_browser_storage_partition_to_untrusted() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    setup = prepare_computer_continuation(plane)
    executor = CountingComputerActionExecutor()
    ComputerWorker(
        plane,
        HttpTurnClient(api, setup.tenant_id),
        action_executor=executor,
    ).run_job(setup.continuation_job)
    assert executor.last_arguments is not None
    assert executor.last_arguments["storage_partition"] == "untrusted"
    api.close()
