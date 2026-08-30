"""Object store for computer snapshot packs.

The filesystem store is the local stand-in for S3. Production uses the
bucket created by CDK stack ``ChatticusSnapshots``.
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
    default_snapshot_bucket,
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

    bucket: str

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

    def __init__(self, root: Path, bucket: str | None = None) -> None:
        self.root = Path(root)
        self.bucket = bucket or default_snapshot_bucket()
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


def open_snapshot_store(store: str) -> SnapshotObjectStore:
    """Open a filesystem store or the CDK S3 bucket.

    ``s3`` or ``s3://bucket`` uses the AWS bucket created by
    ``ChatticusSnapshots``. Any other value is a local directory.
    """
    from urllib.parse import urlparse

    from chatticus.snapshot.uri import LOGICAL_SNAPSHOT_BUCKET

    if store == "s3" or store.startswith("s3://"):
        from chatticus.snapshot.s3 import S3SnapshotStore

        if store == "s3":
            bucket = default_snapshot_bucket()
            if bucket == LOGICAL_SNAPSHOT_BUCKET:
                raise SnapshotPackError(
                    "CHATTICUS_SNAPSHOT_BUCKET is not set. Deploy infra/ with "
                    "CDK and export the SnapshotBucketName output."
                )
            return S3SnapshotStore(bucket)
        parsed = urlparse(store)
        if parsed.scheme != "s3" or not parsed.netloc:
            raise SnapshotPackError(f"Invalid S3 store location {store!r}.")
        return S3SnapshotStore(parsed.netloc)
    return FilesystemSnapshotStore(Path(store))


def _atomic_write(path: Path, data: bytes) -> None:
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_bytes(data)
    os.replace(temporary, path)
