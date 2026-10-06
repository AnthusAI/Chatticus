"""Behave steps for workspace file tools on the computer host."""

from __future__ import annotations

from pathlib import Path

from behave import given, then, when
from host_workspace_helpers import host_live_root

from chatticus.computer_capabilities import WORKSPACE_CAPABILITY
from chatticus.computer_continuation_driver import prepare_workspace_tool_continuation
from chatticus.computer_host_readiness_driver import ComputerHostReadinessDriver
from chatticus.http.client import HttpTurnClient
from chatticus.models import TurnEventKind
from chatticus.worker.computer import ComputerWorker
from chatticus.workspace_action_executor import WorkspaceActionExecutor


@given('a fenced workspace read handoff with a queued continuation job for "{path}"')
def given_workspace_read_handoff(context: object, path: str) -> None:
    context.computer_continuation = _prepare_workspace_read_handoff(context, path)


@given(
    "a fenced workspace read handoff with a tampered queued continuation job for "
    '"{path}"'
)
def given_tampered_workspace_read_handoff(context: object, path: str) -> None:
    context.computer_continuation = _prepare_workspace_read_handoff(
        context,
        path,
        tamper_path=path,
    )


@given(
    "a fenced workspace write handoff with a queued continuation job for "
    '"{path}" containing "{content}"'
)
def given_workspace_write_handoff(context: object, path: str, content: str) -> None:
    context.computer_continuation = _prepare_workspace_write_handoff(
        context, path, content
    )


@given(
    "a fenced workspace write handoff with a tampered queued continuation job for "
    '"{path}" containing "{content}"'
)
def given_tampered_workspace_write_handoff(
    context: object, path: str, content: str
) -> None:
    context.computer_continuation = _prepare_workspace_write_handoff(
        context,
        path,
        content,
        tamper_path=path,
        tamper_content=content,
    )


@given("the computer host has booted through the workspace gate")
def given_host_booted_through_workspace(context: object) -> None:
    driver = ComputerHostReadinessDriver(context.plane)
    driver.boot_through_workspace()
    context.host_readiness = driver


@when("the computer host has booted through the workspace gate")
def when_host_booted_through_workspace(context: object) -> None:
    given_host_booted_through_workspace(context)


@when(
    "a computer-capable pull worker with a workspace executor "
    "pulls that continuation job"
)
def when_worker_pulls_with_workspace_executor(context: object) -> None:
    setup = context.computer_continuation
    if not hasattr(context, "api_client"):
        from browser_auth_helpers import wire_test_http_front_door

        wire_test_http_front_door(context, context.plane, invoke_key="")
    _ensure_host_disk(
        context,
        getattr(context, "host_worker_id", None) or "garage-mac-1",
    )
    live_root = _executor_live_root(context)
    executor = WorkspaceActionExecutor(live_root=live_root)
    ComputerWorker(
        context.plane,
        HttpTurnClient(context.api_client, setup.tenant_id),
        action_executor=executor,
    ).run_job(setup.continuation_job)


@when(
    "a computer-capable pull worker with a workspace executor "
    "completes the escalated turn"
)
def when_worker_completes_escalated_turn(context: object) -> None:
    turn_id = context.last_turn_id
    jobs = [
        job
        for job in context.plane._jobs
        if job.turn_id == turn_id and "computer" in job.required_capabilities
    ]
    assert jobs
    context.computer_continuation = type(
        "Setup",
        (),
        {
            "tenant_id": "anthus",
            "turn_id": turn_id,
            "continuation_job": jobs[-1],
        },
    )()
    when_worker_pulls_with_workspace_executor(context)


@then(
    "the turn journal records a successful read_workspace tool result "
    'with content "{content}"'
)
def then_read_workspace_result_content(context: object, content: str) -> None:
    setup = context.computer_continuation
    events = context.plane.list_turn_events(setup.tenant_id, setup.turn_id)
    results = [
        event.body
        for event in events
        if event.kind == TurnEventKind.TOOL_RESULT
        and event.body
        and not event.body.startswith("denied:")
    ]
    assert results
    assert content in results[-1]


@then("the turn journal records a successful write_workspace tool result")
def then_write_workspace_result(context: object) -> None:
    setup = context.computer_continuation
    events = context.plane.list_turn_events(setup.tenant_id, setup.turn_id)
    results = [
        event
        for event in events
        if event.kind == TurnEventKind.TOOL_RESULT
        and event.body
        and event.body.startswith("write_workspace:")
    ]
    assert results


@then('the turn journal records a read_workspace tool result containing "{snippet}"')
def then_read_workspace_result_contains(context: object, snippet: str) -> None:
    setup = context.computer_continuation
    events = context.plane.list_turn_events(setup.tenant_id, setup.turn_id)
    tool_results = [
        event.body
        for event in events
        if event.kind == TurnEventKind.TOOL_RESULT and event.body
    ]
    assert any(snippet in body for body in tool_results)


@then(
    "the active turn journal records a successful read_workspace tool result "
    'with content "{content}"'
)
def then_active_turn_read_workspace_result(context: object, content: str) -> None:
    events = context.plane.list_turn_events("anthus", context.last_turn_id)
    results = [
        event.body
        for event in events
        if event.kind == TurnEventKind.TOOL_RESULT
        and event.body
        and not event.body.startswith("denied:")
    ]
    assert results
    assert any(content in body for body in results)


@then("the turn is waiting on the workspace capability")
def then_turn_waiting_on_workspace(context: object) -> None:
    turn = context.plane.turn("anthus", context.last_turn_id)
    assert (
        turn.waiting_for == WORKSPACE_CAPABILITY
    ), f"expected waiting_for {WORKSPACE_CAPABILITY!r}, got {turn.waiting_for!r}"


@then("a computer continuation job is queued for the turn")
def then_continuation_job_queued(context: object) -> None:
    turn_id = context.last_turn_id
    jobs = [
        job
        for job in context.plane._jobs
        if job.turn_id == turn_id and "computer" in job.required_capabilities
    ]
    assert jobs


@then("no computer continuation job is queued for the turn")
def then_no_continuation_job_queued(context: object) -> None:
    turn_id = context.last_turn_id
    jobs = [
        job
        for job in context.plane._jobs
        if job.turn_id == turn_id and "computer" in job.required_capabilities
    ]
    assert not jobs


@then("the turn is not waiting on the workspace capability")
def then_turn_not_waiting_on_workspace(context: object) -> None:
    turn = context.plane.turn("anthus", context.last_turn_id)
    assert turn.waiting_for != WORKSPACE_CAPABILITY, (
        f"expected turn not to wait on {WORKSPACE_CAPABILITY!r}, "
        f"got waiting_for={turn.waiting_for!r}"
    )


@then("the household computer is stopped")
def then_household_computer_stopped(context: object) -> None:
    assert context.plane.computer_is_stopped("anthus") is True


def _executor_live_root(context: object) -> object:
    hosts = getattr(context, "computer_hosts", None)
    if hosts:
        worker_id = getattr(context, "host_worker_id", None)
        if worker_id and worker_id in hosts:
            return hosts[worker_id].live_root
        if "garage-mac-1" in hosts:
            return hosts["garage-mac-1"].live_root
    return host_live_root(context)


def _ensure_host_disk(context: object, name: str) -> None:
    from chatticus.snapshot.host import ComputerHostDisk
    from chatticus.snapshot.store import FilesystemSnapshotStore

    hosts = getattr(context, "computer_hosts", None)
    if hosts is None:
        context.computer_hosts = {}
        hosts = context.computer_hosts
    if name in hosts:
        return
    snapshot_store = getattr(context, "snapshot_store", None)
    snapshot_tmpdir = getattr(context, "snapshot_tmpdir", None)
    if snapshot_store is not None and snapshot_tmpdir is not None:
        live_root = Path(snapshot_tmpdir) / "hosts" / name
        hosts[name] = ComputerHostDisk(live_root, snapshot_store)
        return
    root = host_live_root(context)
    store = FilesystemSnapshotStore(root / ".ephemeral-snapshot")
    hosts[name] = ComputerHostDisk(root, store)


@given(
    'the scenario host "{name}" seeds workspace file "{path}" containing "{content}"'
)
def given_scenario_host_seeds(
    context: object, name: str, path: str, content: str
) -> None:
    _ensure_host_disk(context, name)
    context.computer_hosts[name].write_workspace_file(path, content)


def _prepare_workspace_read_handoff(
    context: object,
    path: str,
    *,
    tamper_path: str | None = None,
) -> object:
    setup_path = "/workspace/research/decoy.txt" if tamper_path is not None else path
    setup = prepare_workspace_tool_continuation(
        context.plane,
        tool_name="read_workspace",
        arguments={"path": setup_path},
    )
    if tamper_path is not None:
        _tamper_committed_workspace_handoff(
            context.plane,
            setup,
            path=tamper_path,
        )
    context.last_turn_id = setup.turn_id
    context.continuation_job = setup.continuation_job
    return setup


def _prepare_workspace_write_handoff(
    context: object,
    path: str,
    content: str,
    *,
    tamper_path: str | None = None,
    tamper_content: str | None = None,
) -> object:
    setup_path = "/workspace/research/decoy.txt" if tamper_path is not None else path
    setup = prepare_workspace_tool_continuation(
        context.plane,
        tool_name="write_workspace",
        arguments={"path": setup_path, "content": content},
    )
    if tamper_path is not None:
        _tamper_committed_workspace_handoff(
            context.plane,
            setup,
            path=tamper_path,
            content=tamper_content if tamper_content is not None else content,
        )
    context.last_turn_id = setup.turn_id
    context.continuation_job = setup.continuation_job
    return setup


def _tamper_committed_workspace_handoff(
    plane: object,
    setup: object,
    *,
    path: str,
    content: str | None = None,
) -> None:
    record = plane.escalation_for(setup.tenant_id, setup.turn_id)
    record.pending_call.arguments["path"] = path
    if content is not None:
        record.pending_call.arguments["content"] = content
    for event in plane.list_turn_events(setup.tenant_id, setup.turn_id):
        snapshot = event.pending_computer_tool
        if event.kind != TurnEventKind.TOOL_CALL or snapshot is None:
            continue
        snapshot.arguments["path"] = path
        if content is not None:
            snapshot.arguments["content"] = content
        break
