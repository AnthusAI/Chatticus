"""Object store for computer snapshot packs.

The filesystem store is the local stand-in for S3. Hosts publish and
hydrate against the same directory tree. A later S3 adapter keeps the
same URI and pack layout.
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Protocol

from chatticus.snapshot.pack import SnapshotPackError
from chatticus.snapshot.uri import (
    MANIFEST_FILENAME,
    PACK_FILENAME,
    snapshot_object_dir,
)


@dataclass(frozen=True)
class SnapshotManifest:
    """Metadata stored next to a snapshot pack."""

    tenant_id: str
    computer_id: str
    checksum: str
    published_by_worker_id: str
    published_at: str
    image_digest: str | None = None
    pack_filename: str = PACK_FILENAME


class SnapshotObjectStore(Protocol):
    """Put and get snapshot packs by canonical URI."""

    def put(self, snapshot_uri: str, pack: bytes, manifest: SnapshotManifest) -> None:
        """Store a pack and its manifest at the snapshot URI."""

    def get_pack(self, snapshot_uri: str) -> bytes:
        """Return the pack bytes for a snapshot URI."""

    def get_manifest(self, snapshot_uri: str) -> SnapshotManifest:
        """Return the manifest for a snapshot URI."""


class FilesystemSnapshotStore:
    """Object store rooted on a local directory.

    URIs keep the ``s3://chatticus/...`` form so a Mac and a Fargate task
    can later share a real bucket without changing callers.
    """

    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def put(self, snapshot_uri: str, pack: bytes, manifest: SnapshotManifest) -> None:
        """Write pack and manifest atomically next to each other."""
        directory = self._directory(snapshot_uri)
        directory.mkdir(parents=True, exist_ok=True)
        _atomic_write(directory / PACK_FILENAME, pack)
        payload = json.dumps(asdict(manifest), indent=2, sort_keys=True) + "\n"
        _atomic_write(directory / MANIFEST_FILENAME, payload.encode())

    def get_pack(self, snapshot_uri: str) -> bytes:
        """Return the pack bytes for a snapshot URI."""
        path = self._directory(snapshot_uri) / PACK_FILENAME
        if not path.is_file():
            raise SnapshotPackError(f"No snapshot pack at {snapshot_uri!r}.")
        return path.read_bytes()

    def get_manifest(self, snapshot_uri: str) -> SnapshotManifest:
        """Return the manifest for a snapshot URI."""
        path = self._directory(snapshot_uri) / MANIFEST_FILENAME
        if not path.is_file():
            raise SnapshotPackError(f"No snapshot manifest at {snapshot_uri!r}.")
        payload = json.loads(path.read_text())
        return SnapshotManifest(**payload)

    def _directory(self, snapshot_uri: str) -> Path:
        return self.root / snapshot_object_dir(snapshot_uri)


def _atomic_write(path: Path, data: bytes) -> None:
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_bytes(data)
    os.replace(temporary, path)
