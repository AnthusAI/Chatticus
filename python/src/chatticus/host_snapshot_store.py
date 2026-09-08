"""Resolve the snapshot object store configured on a computer host."""

from __future__ import annotations

import os
from pathlib import Path

from chatticus.snapshot.store import FilesystemSnapshotStore, SnapshotObjectStore

_counting_stores: dict[str, SnapshotObjectStore] = {}


def register_snapshot_store_for_root(root: Path, store: SnapshotObjectStore) -> None:
    """Return *store* from :func:`snapshot_store_from_env` for this root path."""
    _counting_stores[str(root.resolve())] = store


def clear_snapshot_store_for_root(root: Path) -> None:
    """Drop a registered stand-in store after one scenario."""
    _counting_stores.pop(str(root.resolve()), None)


def live_root_from_env() -> Path:
    """Return the host live-disk root from the environment."""
    return Path(
        os.environ.get("CHATTICUS_LIVE_ROOT", "/var/lib/chatticus/computer").rstrip("/")
    )


def snapshot_store_from_env() -> SnapshotObjectStore | None:
    """Return a snapshot store when configured, otherwise None.

    Hosts skip hydrate and publish when no store is configured. The
    filesystem root is the Gherkin stand-in. A bucket name is honored only
    when ``CHATTICUS_SNAPSHOT_BUCKET`` is set explicitly; there is no
    default to the Anthus CDK bucket.
    """
    root = os.environ.get("CHATTICUS_SNAPSHOT_STORE_ROOT", "").strip()
    if root:
        resolved = Path(root).resolve()
        registered = _counting_stores.get(str(resolved))
        if registered is not None:
            return registered
        return FilesystemSnapshotStore(resolved)
    bucket = os.environ.get("CHATTICUS_SNAPSHOT_BUCKET", "").strip()
    if bucket:
        from chatticus.snapshot.s3 import S3SnapshotStore

        return S3SnapshotStore(bucket)
    return None
