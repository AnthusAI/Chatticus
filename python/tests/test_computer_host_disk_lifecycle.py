"""Tests for host disk hydrate-on-boot and publish-before-exit helpers."""

from __future__ import annotations

import os
from pathlib import Path

from chatticus.computer_host_disk_lifecycle import (
    host_disk_needs_publish,
    hydrate_on_boot,
    live_disk_pack_checksum,
)
from chatticus.computer_host_worker import shutdown_host_worker
from chatticus.control_plane import ControlPlane
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


def test_hydrate_on_boot_skips_without_store() -> None:
    os.environ.pop("CHATTICUS_SNAPSHOT_STORE_ROOT", None)
    plane = ControlPlane()
    _register_host(plane, "garage-mac-1")
    assert hydrate_on_boot(plane, tenant_id="anthus", worker_id="garage-mac-1") is False


def test_host_disk_needs_publish_when_checksum_missing(tmp_path: Path) -> None:
    live_root = tmp_path / "host"
    live_root.mkdir()
    (live_root / "workspace").mkdir()
    assert host_disk_needs_publish(live_root, None) is True


def test_host_disk_needs_publish_when_live_bytes_changed(tmp_path: Path) -> None:
    store = FilesystemSnapshotStore(tmp_path / "store")
    live_root = tmp_path / "host"
    disk = ComputerHostDisk(live_root, store)
    disk.write_workspace_file("notes.md", "first")
    published = live_disk_pack_checksum(live_root)
    disk.write_workspace_file("notes.md", "second")
    assert host_disk_needs_publish(live_root, published) is True
    assert (
        host_disk_needs_publish(live_root, live_disk_pack_checksum(live_root)) is False
    )


def test_shutdown_skips_publish_without_store() -> None:
    os.environ.pop("CHATTICUS_SNAPSHOT_STORE_ROOT", None)
    plane = ControlPlane()
    _register_host(plane, "computer-host")
    shutdown_host_worker(plane=plane, tenant_id="anthus", worker_id="computer-host")
    assert plane.computer_for_organization("anthus").stopped is True
    assert plane.computer_for_organization("anthus").snapshot_uri is None
