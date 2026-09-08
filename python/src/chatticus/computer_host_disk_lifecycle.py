"""Hydrate-on-boot and publish-before-exit for the summoned computer host."""

from __future__ import annotations

import logging
from pathlib import Path

from chatticus.host_snapshot_store import live_root_from_env, snapshot_store_from_env
from chatticus.snapshot.host import ComputerHostDisk
from chatticus.snapshot.store import SnapshotObjectStore
from chatticus.worker.computer_worker_plane import ComputerWorkerPlane

logger = logging.getLogger("chatticus.computer_host_disk_lifecycle")


def hydrate_on_boot(
    plane: ComputerWorkerPlane,
    *,
    tenant_id: str,
    worker_id: str,
    live_root: Path | None = None,
    store: SnapshotObjectStore | None = None,
) -> bool:
    """Load a published pack onto the host disk when a store is configured."""
    resolved_store = store if store is not None else snapshot_store_from_env()
    if resolved_store is None:
        return False
    computer = plane.computer_for_organization(tenant_id)
    if computer.snapshot_uri is None:
        return False
    root = live_root if live_root is not None else live_root_from_env()
    disk = ComputerHostDisk(root, resolved_store)
    needs_hydrate_record = computer.hydrate_required
    try:
        disk.hydrate(tenant_id=tenant_id, computer_id=computer.computer_id)
    except Exception:
        logger.exception(
            "computer_host_hydrate_failed tenant_id=%s computer_id=%s",
            tenant_id,
            computer.computer_id,
        )
        raise
    if needs_hydrate_record:
        plane.record_computer_hydrated(tenant_id, worker_id)
    return True


def publish_before_exit(
    plane: ComputerWorkerPlane,
    *,
    tenant_id: str,
    worker_id: str,
    live_root: Path | None = None,
    store: SnapshotObjectStore | None = None,
) -> bool:
    """Pack and upload a dirty host disk, then persist snapshot metadata."""
    resolved_store = store if store is not None else snapshot_store_from_env()
    if resolved_store is None:
        return False
    computer = plane.computer_for_organization(tenant_id)
    if not computer.disk_dirty:
        return False
    root = live_root if live_root is not None else live_root_from_env()
    disk = ComputerHostDisk(root, resolved_store)
    manifest = disk.publish(
        tenant_id=tenant_id,
        computer_id=computer.computer_id,
        worker_id=worker_id,
    )
    plane.publish_computer_snapshot(tenant_id, worker_id, manifest.checksum)
    return True
