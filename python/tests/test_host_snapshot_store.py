"""Tests for host snapshot store resolution."""

from __future__ import annotations

import os
from pathlib import Path

from chatticus.host_snapshot_store import snapshot_store_from_env
from chatticus.snapshot.store import FilesystemSnapshotStore


def test_snapshot_store_from_env_uses_filesystem_root(tmp_path: Path) -> None:
    root = tmp_path / "store"
    os.environ["CHATTICUS_SNAPSHOT_STORE_ROOT"] = str(root)
    try:
        store = snapshot_store_from_env()
    finally:
        os.environ.pop("CHATTICUS_SNAPSHOT_STORE_ROOT", None)
    assert isinstance(store, FilesystemSnapshotStore)
    assert store.root == root


def test_snapshot_store_from_env_returns_none_when_unconfigured(
    tmp_path: Path,
) -> None:
    os.environ.pop("CHATTICUS_SNAPSHOT_STORE_ROOT", None)
    os.environ.pop("CHATTICUS_SNAPSHOT_BUCKET", None)
    assert snapshot_store_from_env() is None
