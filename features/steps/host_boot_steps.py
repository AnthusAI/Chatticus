"""Behave steps for booting a customer computer host in the features still on behave."""

from __future__ import annotations

import os
from pathlib import Path
from unittest.mock import patch

from behave import given, then, when
from host_workspace_helpers import host_live_root
from snapshot_steps import CountingSnapshotStore

from chatticus.computer_capabilities import (
    BROWSER_CAPABILITY,
    MODEL_CAPABILITY,
    WORKSPACE_CAPABILITY,
)
from chatticus.computer_host_boot import ComputerHostBootDriver
from chatticus.computer_host_readiness_driver import ComputerHostReadinessDriver
from chatticus.http.worker_plane_client import HttpWorkerPlane
from chatticus.snapshot.host import ComputerHostDisk
from chatticus.snapshot.store import FilesystemSnapshotStore


def _bind_snapshot_store(context: object) -> None:
    root = Path(context.snapshot_tmpdir) / "store"
    store = CountingSnapshotStore(FilesystemSnapshotStore(root))
    context.snapshot_store = store
    context._snapshot_store_root = root
    os.environ["CHATTICUS_SNAPSHOT_STORE_ROOT"] = str(root)
    from chatticus.host_snapshot_store import register_snapshot_store_for_root

    register_snapshot_store_for_root(root, store)


def _host_live_root(context: object, host_name: str) -> Path:
    hosts = getattr(context, "computer_hosts", None)
    if hosts is None:
        context.computer_hosts = {}
        hosts = context.computer_hosts
    if host_name not in hosts:
        live_root = Path(context.snapshot_tmpdir) / "hosts" / host_name
        hosts[host_name] = ComputerHostDisk(live_root, context.snapshot_store)
    return hosts[host_name].live_root


def _worker_plane(context: object, worker_id: str) -> HttpWorkerPlane:
    return HttpWorkerPlane(
        context.api_client,
        "anthus",
        "ryan",
        invoke_key="",
        worker_id=worker_id,
    )


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


@given("a filesystem snapshot store bound to the host worker")
def given_filesystem_store_bound(context: object) -> None:
    _bind_snapshot_store(context)
    context.computer_hosts = {}


@given(
    'the scenario host "{name}" seeds workspace file "{path}" containing "{content}"'
)
def given_scenario_host_seeds(
    context: object, name: str, path: str, content: str
) -> None:
    _ensure_host_disk(context, name)
    context.computer_hosts[name].write_workspace_file(path, content)


@given("the computer host has booted through the workspace gate")
def given_host_booted_through_workspace(context: object) -> None:
    driver = ComputerHostReadinessDriver(context.plane)
    driver.boot_through_workspace()
    context.host_readiness = driver


@when("the computer host has booted through the workspace gate")
def when_host_booted_through_workspace(context: object) -> None:
    given_host_booted_through_workspace(context)


@when(
    'the customer computer host "{worker_id}" boots through the Front Door worker plane'
)
def when_customer_host_boots(context: object, worker_id: str) -> None:
    live_root = _host_live_root(context, worker_id)
    os.environ["CHATTICUS_LIVE_ROOT"] = str(live_root)
    driver = ComputerHostBootDriver(
        _worker_plane(context, worker_id),
        tenant_id="anthus",
        user_id="ryan",
        worker_id=worker_id,
    )
    with (
        patch.object(driver._xvfb, "start"),
        patch(
            "chatticus.computer_host_boot.verify_chromium_available",
            return_value="Chromium 120.0.0.0",
        ),
    ):
        context.host_boot = driver.boot_through_browser()
        context.host_worker_id = worker_id


@then("the Front Door received no snapshot hydrate or publish requests")
def then_no_snapshot_metadata_routes(context: object) -> None:
    assert getattr(context, "snapshot_metadata_route_calls", 0) == 0


@then(
    "tenant {tenant_id} household computer readiness reports browser ready after "
    "workspace"
)
def then_browser_ready_after_workspace(context: object, tenant_id: str) -> None:
    del tenant_id
    order = context.host_boot.readiness_order
    assert order.index(WORKSPACE_CAPABILITY) < order.index(BROWSER_CAPABILITY)
    readiness = _worker_plane(
        context, context.host_worker_id
    ).computer_capability_readiness("anthus")
    assert readiness.is_ready(BROWSER_CAPABILITY) is True


@then(
    "tenant {tenant_id} household computer readiness reports workspace "
    "ready after model"
)
def then_workspace_ready_after_model(context: object, tenant_id: str) -> None:
    del tenant_id
    order = context.host_boot.readiness_order
    assert order.index(MODEL_CAPABILITY) < order.index(WORKSPACE_CAPABILITY)
    readiness = _worker_plane(
        context, context.host_worker_id
    ).computer_capability_readiness("anthus")
    assert readiness.is_ready(WORKSPACE_CAPABILITY) is True


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
