"""Hydrate-on-boot and publish-before-exit for the summoned computer host."""

from __future__ import annotations

import logging
from pathlib import Path

from chatticus.host_snapshot_store import live_root_from_env, snapshot_store_from_env
from chatticus.snapshot.host import ComputerHostDisk
from chatticus.snapshot.pack import pack_checksum, pack_live_disk
from chatticus.snapshot.s3 import is_no_such_bucket_error
from chatticus.snapshot.store import SnapshotObjectStore
from chatticus.snapshot.uri import snapshot_uri
from chatticus.worker.computer_worker_plane import ComputerWorkerPlane

logger = logging.getLogger("chatticus.computer_host_disk_lifecycle")


def live_disk_pack_checksum(live_root: Path) -> str:
    """Return the checksum of the current host live-disk pack."""
    return pack_checksum(pack_live_disk(live_root))


def host_disk_needs_publish(
    live_root: Path,
    published_checksum: str | None,
) -> bool:
    """Return True when live host bytes differ from the last published pack."""
    if published_checksum is None:
        return True
    return live_disk_pack_checksum(live_root) != published_checksum


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
    except Exception as error:
        if is_no_such_bucket_error(error):
            logger.warning(
                "computer_host_hydrate_skipped_missing_bucket tenant_id=%s "
                "computer_id=%s bucket=%s",
                tenant_id,
                computer.computer_id,
                resolved_store.bucket,
            )
            return False
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
    root = live_root if live_root is not None else live_root_from_env()
    if not host_disk_needs_publish(root, computer.snapshot_checksum):
        return False
    disk = ComputerHostDisk(root, resolved_store)
    try:
        manifest = disk.publish(
            tenant_id=tenant_id,
            computer_id=computer.computer_id,
            worker_id=worker_id,
        )
    except Exception as error:
        if is_no_such_bucket_error(error):
            logger.warning(
                "computer_host_publish_skipped_missing_bucket tenant_id=%s "
                "computer_id=%s bucket=%s",
                tenant_id,
                computer.computer_id,
                resolved_store.bucket,
            )
            return False
        raise
    uri = snapshot_uri(
        tenant_id=tenant_id,
        computer_id=computer.computer_id,
        bucket=resolved_store.bucket,
    )
    plane.publish_computer_snapshot(
        tenant_id,
        worker_id,
        manifest.checksum,
        snapshot_uri=uri,
    )
    return True
