"""Behave steps for computer host disk hydrate and publish."""

from __future__ import annotations

import os
from pathlib import Path
from unittest.mock import patch

from behave import given, then, when
from snapshot_steps import CountingSnapshotStore

from chatticus.computer_capabilities import (
    BROWSER_CAPABILITY,
    MODEL_CAPABILITY,
    WORKSPACE_CAPABILITY,
)
from chatticus.computer_host_boot import ComputerHostBootDriver
from chatticus.computer_host_worker import shutdown_host_worker
from chatticus.http.worker_plane_client import HttpWorkerPlane
from chatticus.snapshot.host import ComputerHostDisk
from chatticus.snapshot.store import FilesystemSnapshotStore
from chatticus.snapshot.uri import snapshot_uri


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


@given("a filesystem snapshot store bound to the host worker")
def given_filesystem_store_bound(context: object) -> None:
    _bind_snapshot_store(context)
    context.computer_hosts = {}


@given(
    'worker "{worker_id}" has published computer "{computer_id}" with workspace '
    'file "{path}" containing "{content}"'
)
def given_worker_published_computer(
    context: object,
    worker_id: str,
    computer_id: str,
    path: str,
    content: str,
) -> None:
    _bind_snapshot_store(context)
    live_root = _host_live_root(context, worker_id)
    os.environ["CHATTICUS_LIVE_ROOT"] = str(live_root)
    disk = ComputerHostDisk(live_root, context.snapshot_store)
    disk.write_workspace_file(path, content)
    manifest = disk.publish(
        tenant_id="anthus",
        computer_id=computer_id,
        worker_id=worker_id,
    )
    uri = snapshot_uri(
        "anthus",
        computer_id,
        bucket=context.snapshot_store.bucket,
    )
    context.plane.record_host_snapshot_published(
        computer_id,
        worker_id,
        manifest.checksum,
        uri,
    )


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


@when('the customer computer host "{worker_id}" boots without a snapshot store')
def when_customer_host_boots_without_store(context: object, worker_id: str) -> None:
    os.environ.pop("CHATTICUS_SNAPSHOT_STORE_ROOT", None)
    snapshot_store_root = getattr(context, "_snapshot_store_root", None)
    if snapshot_store_root is not None:
        from chatticus.host_snapshot_store import clear_snapshot_store_for_root

        clear_snapshot_store_for_root(snapshot_store_root)
        context._snapshot_store_root = None
    live_root = Path(context.snapshot_tmpdir) / "hosts" / worker_id
    live_root.mkdir(parents=True, exist_ok=True)
    os.environ["CHATTICUS_LIVE_ROOT"] = str(live_root)
    context.computer_hosts = {}
    context.snapshot_metadata_route_calls = 0
    plane = _worker_plane(context, worker_id)
    original_hydrated = plane.record_computer_hydrated
    original_publish = plane.publish_computer_snapshot

    def counting_hydrated(*args: object, **kwargs: object) -> None:
        context.snapshot_metadata_route_calls += 1
        return original_hydrated(*args, **kwargs)

    def counting_publish(*args: object, **kwargs: object) -> None:
        context.snapshot_metadata_route_calls += 1
        return original_publish(*args, **kwargs)

    plane.record_computer_hydrated = counting_hydrated  # type: ignore[method-assign]
    plane.publish_computer_snapshot = counting_publish  # type: ignore[method-assign]
    driver = ComputerHostBootDriver(
        plane,
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


@when('worker "{caller_id}" posts snapshot publish metadata as worker "{claimed_id}"')
def when_worker_posts_publish_as_other(
    context: object, caller_id: str, claimed_id: str
) -> None:
    plane = _worker_plane(context, caller_id)
    context.snapshot_http_error = None
    try:
        plane.publish_computer_snapshot("anthus", claimed_id, "0" * 64)
    except RuntimeError as error:
        context.snapshot_http_error = error


@then("snapshot metadata publish is rejected with forbidden")
def then_snapshot_publish_forbidden(context: object) -> None:
    assert context.snapshot_http_error is not None
    assert "403" in str(context.snapshot_http_error)


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


@when(
    'the customer computer host "{worker_id}" shuts down through the Front Door '
    "worker plane"
)
def when_customer_host_shuts_down(context: object, worker_id: str) -> None:
    live_root = _host_live_root(context, worker_id)
    os.environ["CHATTICUS_LIVE_ROOT"] = str(live_root)
    shutdown_host_worker(
        plane=_worker_plane(context, worker_id),
        tenant_id="anthus",
        worker_id=worker_id,
    )


@when("the Front Door is recycled onto the same messaging store")
def when_front_door_recycled(context: object) -> None:
    from browser_auth_helpers import wire_test_http_front_door

    from chatticus.control_plane import ControlPlane

    context.api_client.close()
    context.plane = ControlPlane(messaging_store=context.messaging_store)
    wire_test_http_front_door(context, context.plane, invoke_key="")


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
