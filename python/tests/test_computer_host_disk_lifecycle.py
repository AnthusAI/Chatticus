"""Tests for host disk hydrate-on-boot and publish-before-exit."""

from __future__ import annotations

import os
from pathlib import Path
from unittest.mock import patch

from chatticus.computer_host_boot import ComputerHostBootDriver
from chatticus.computer_host_disk_lifecycle import hydrate_on_boot, publish_before_exit
from chatticus.computer_host_worker import shutdown_host_worker
from chatticus.control_plane import ControlPlane
from chatticus.messaging.store import InMemoryMessagingStore
from chatticus.models import WorkerRegistration
from chatticus.snapshot.host import ComputerHostDisk
from chatticus.snapshot.store import FilesystemSnapshotStore


def _register_host(
    plane: ControlPlane, worker_id: str, *, computer_id: str = "household-computer"
) -> None:
    plane.register_worker(
        WorkerRegistration(
            worker_id=worker_id,
            tenant_id="anthus",
            cost_class="local",
            capabilities=frozenset({"computer", "browser"}),
            computer_id=computer_id,
        )
    )
    plane.ensure_computer("anthus", computer_id=computer_id)


def test_hydrate_on_boot_skips_without_store(tmp_path: Path) -> None:
    os.environ.pop("CHATTICUS_SNAPSHOT_STORE_ROOT", None)
    plane = ControlPlane()
    _register_host(plane, "garage-mac-1")
    assert hydrate_on_boot(plane, tenant_id="anthus", worker_id="garage-mac-1") is False


def test_boot_records_workspace_after_hydrate(tmp_path: Path) -> None:
    store_root = tmp_path / "store"
    live_root = tmp_path / "hosts" / "fargate-1"
    os.environ["CHATTICUS_SNAPSHOT_STORE_ROOT"] = str(store_root)
    os.environ["CHATTICUS_LIVE_ROOT"] = str(live_root)
    try:
        store = FilesystemSnapshotStore(store_root)
        plane = ControlPlane()
        _register_host(plane, "fargate-1")
        _register_host(plane, "garage-mac-1")
        seed = ComputerHostDisk(live_root / "seed", store)
        seed.write_workspace_file("notes.md", "weekly account list")
        manifest = seed.publish(
            tenant_id="anthus",
            computer_id="household-computer",
            worker_id="fargate-1",
        )
        plane.record_host_snapshot_published(
            "household-computer",
            "fargate-1",
            manifest.checksum,
        )
        plane.relocate_computer("household-computer", "garage-mac-1")
        target_live = tmp_path / "hosts" / "garage-mac-1"
        os.environ["CHATTICUS_LIVE_ROOT"] = str(target_live)
        driver = ComputerHostBootDriver(
            plane,
            tenant_id="anthus",
            user_id="ryan",
            worker_id="garage-mac-1",
        )
        with (
            patch.object(driver._xvfb, "start"),
            patch(
                "chatticus.computer_host_boot.verify_chromium_available",
                return_value="Chromium 120.0.0.0",
            ),
        ):
            driver.boot_through_browser()
        disk = ComputerHostDisk(target_live, store)
        assert disk.read_workspace_file("notes.md") == "weekly account list"
        assert plane.computer_for_organization("anthus").hydrate_required is False
        assert "workspace" in driver.readiness_order
        assert driver.readiness_order.index("model") < driver.readiness_order.index(
            "workspace"
        )
    finally:
        os.environ.pop("CHATTICUS_SNAPSHOT_STORE_ROOT", None)
        os.environ.pop("CHATTICUS_LIVE_ROOT", None)


def test_publish_before_exit_persists_metadata(tmp_path: Path) -> None:
    store_root = tmp_path / "store"
    live_root = tmp_path / "hosts" / "garage-mac-1"
    os.environ["CHATTICUS_SNAPSHOT_STORE_ROOT"] = str(store_root)
    os.environ["CHATTICUS_LIVE_ROOT"] = str(live_root)
    try:
        store = FilesystemSnapshotStore(store_root)
        plane = ControlPlane(messaging_store=InMemoryMessagingStore())
        _register_host(plane, "garage-mac-1")
        computer = plane.computer_for_organization("anthus")
        computer.disk_dirty = True
        plane._messaging_store.put_computer(computer)
        disk = ComputerHostDisk(live_root, store)
        disk.write_workspace_file("notes.md", "unsynced edits")
        assert publish_before_exit(plane, tenant_id="anthus", worker_id="garage-mac-1")
        stored = plane.computer_for_organization("anthus")
        assert stored.disk_dirty is False
        assert stored.snapshot_uri is not None
        assert stored.snapshot_checksum is not None
    finally:
        os.environ.pop("CHATTICUS_SNAPSHOT_STORE_ROOT", None)
        os.environ.pop("CHATTICUS_LIVE_ROOT", None)


def test_shutdown_skips_publish_without_store(tmp_path: Path) -> None:
    os.environ.pop("CHATTICUS_SNAPSHOT_STORE_ROOT", None)
    plane = ControlPlane()
    _register_host(plane, "computer-host")
    computer = plane.computer_for_organization("anthus")
    computer.disk_dirty = True
    plane._messaging_store.put_computer(computer)
    shutdown_host_worker(plane=plane, tenant_id="anthus", worker_id="computer-host")
    assert plane.computer_for_organization("anthus").stopped is True
    assert plane.computer_for_organization("anthus").disk_dirty is True
