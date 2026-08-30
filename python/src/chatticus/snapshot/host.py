"""A host's local cache of a Chatticus computer."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from chatticus.snapshot.pack import (
    BROWSER_PROFILE_DIRNAME,
    CACHE_CHECKSUM_FILENAME,
    WORKSPACE_DIRNAME,
    pack_checksum,
    pack_live_disk,
    unpack_live_disk,
)
from chatticus.snapshot.store import SnapshotManifest, SnapshotObjectStore
from chatticus.snapshot.uri import snapshot_uri


class SnapshotChecksumMismatchError(ValueError):
    """The downloaded pack does not match the published checksum."""


class ComputerHostDisk:
    """Live workplace files on one host, hydrated from a shared store.

    This is the Mac, Fargate, or EC2 cache. The store is the checkpoint
    every host can see. Publish uploads. Hydrate downloads unless the
    local checksum already matches.
    """

    def __init__(self, live_root: Path, store: SnapshotObjectStore) -> None:
        self.live_root = Path(live_root)
        self.store = store
        self.live_root.mkdir(parents=True, exist_ok=True)
        (self.live_root / WORKSPACE_DIRNAME).mkdir(parents=True, exist_ok=True)
        (self.live_root / BROWSER_PROFILE_DIRNAME).mkdir(parents=True, exist_ok=True)

    def write_workspace_file(self, relative_path: str, content: str) -> None:
        """Write a file under the host's ``workspace`` tree."""
        path = _safe_join(self.live_root / WORKSPACE_DIRNAME, relative_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    def write_browser_profile_file(self, relative_path: str, content: str) -> None:
        """Write a file under the host's browser profile tree."""
        path = _safe_join(self.live_root / BROWSER_PROFILE_DIRNAME, relative_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    def read_workspace_file(self, relative_path: str) -> str:
        """Read a workspace file from this host's live disk."""
        return _safe_join(self.live_root / WORKSPACE_DIRNAME, relative_path).read_text()

    def read_browser_profile_file(self, relative_path: str) -> str:
        """Read a browser-profile file from this host's live disk."""
        return _safe_join(
            self.live_root / BROWSER_PROFILE_DIRNAME, relative_path
        ).read_text()

    def publish(
        self,
        *,
        tenant_id: str,
        computer_id: str,
        worker_id: str,
        image_digest: str | None = None,
        published_at: datetime | None = None,
    ) -> SnapshotManifest:
        """Pack the live disk and upload it to the shared store."""
        uri = snapshot_uri(tenant_id, computer_id)
        pack = pack_live_disk(self.live_root)
        checksum = pack_checksum(pack)
        manifest = SnapshotManifest(
            tenant_id=tenant_id,
            computer_id=computer_id,
            checksum=checksum,
            published_by_worker_id=worker_id,
            published_at=(published_at or datetime.now(UTC)).isoformat(),
            image_digest=image_digest,
        )
        self.store.put(uri, pack, manifest)
        self._write_cache_checksum(checksum)
        return manifest

    def hydrate(self, *, tenant_id: str, computer_id: str) -> SnapshotManifest:
        """Load the published snapshot unless this host already has it."""
        uri = snapshot_uri(tenant_id, computer_id)
        manifest = self.store.get_manifest(uri)
        if self.cache_matches(manifest.checksum):
            return manifest
        pack = self.store.get_pack(uri)
        actual = pack_checksum(pack)
        if actual != manifest.checksum:
            raise SnapshotChecksumMismatchError(
                f"Snapshot pack checksum {actual!r} does not match "
                f"manifest {manifest.checksum!r}."
            )
        unpack_live_disk(pack, self.live_root)
        self._write_cache_checksum(manifest.checksum)
        return manifest

    def cache_matches(self, checksum: str) -> bool:
        """Return True if the local cache already holds this snapshot."""
        cache = self.live_root / CACHE_CHECKSUM_FILENAME
        if not cache.is_file():
            return False
        if cache.read_text().strip() != checksum:
            return False
        return (self.live_root / WORKSPACE_DIRNAME).is_dir()

    def _write_cache_checksum(self, checksum: str) -> None:
        (self.live_root / CACHE_CHECKSUM_FILENAME).write_text(checksum + "\n")


def _safe_join(root: Path, relative_path: str) -> Path:
    root = root.resolve()
    candidate = (root / relative_path).resolve()
    if candidate != root and root not in candidate.parents:
        raise ValueError(f"Path {relative_path!r} escapes {root}.")
    return candidate
