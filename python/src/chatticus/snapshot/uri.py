"""Canonical snapshot URI and safe object-store keys."""

from __future__ import annotations

import os
import re
from pathlib import Path
from urllib.parse import urlparse

LOGICAL_SNAPSHOT_BUCKET = "chatticus"
PACK_FILENAME = "snapshot.tar.gz"
MANIFEST_FILENAME = "manifest.json"

_SEGMENT = re.compile(r"^[A-Za-z0-9._-]+$")


class SnapshotUriError(ValueError):
    """The snapshot URI is not a Chatticus computer snapshot location."""


def _require_segment(value: str, name: str) -> str:
    if not _SEGMENT.fullmatch(value):
        raise SnapshotUriError(f"Invalid {name} {value!r} in snapshot URI.")
    return value


def default_snapshot_bucket() -> str:
    """Return the bucket name from the environment, or the local logical name.

    Production sets ``CHATTICUS_SNAPSHOT_BUCKET`` to the CDK
    ``SnapshotBucketName`` output. Tests and the filesystem store use the
    logical name ``chatticus``.
    """
    return os.environ.get("CHATTICUS_SNAPSHOT_BUCKET") or LOGICAL_SNAPSHOT_BUCKET


def snapshot_uri(
    tenant_id: str,
    computer_id: str,
    *,
    bucket: str | None = None,
) -> str:
    """Return the canonical object-store URI for a computer snapshot."""
    resolved_bucket = _require_segment(bucket or default_snapshot_bucket(), "bucket")
    _require_segment(tenant_id, "tenant_id")
    _require_segment(computer_id, "computer_id")
    return (
        f"s3://{resolved_bucket}/tenants/{tenant_id}"
        f"/computers/{computer_id}/snapshot"
    )


def snapshot_bucket_and_prefix(snapshot_location: str) -> tuple[str, Path]:
    """Return ``(bucket, key prefix)`` for a snapshot URI.

    ``s3://{bucket}/tenants/{tenant}/computers/{computer}/snapshot`` maps to
    prefix ``tenants/{tenant}/computers/{computer}``.
    """
    parsed = urlparse(snapshot_location)
    if parsed.scheme != "s3":
        raise SnapshotUriError(
            f"Snapshot URI must use the s3 scheme, not {parsed.scheme!r}."
        )
    bucket = _require_segment(parsed.netloc, "bucket")
    parts = [part for part in parsed.path.split("/") if part]
    if (
        len(parts) != 5
        or parts[0] != "tenants"
        or parts[2] != "computers"
        or parts[4] != "snapshot"
    ):
        raise SnapshotUriError(
            f"Snapshot URI path is not a computer snapshot: {snapshot_location!r}."
        )
    tenant_id = _require_segment(parts[1], "tenant_id")
    computer_id = _require_segment(parts[3], "computer_id")
    return bucket, Path("tenants") / tenant_id / "computers" / computer_id


def snapshot_object_dir(snapshot_location: str) -> Path:
    """Return the relative store directory for a snapshot URI."""
    _bucket, prefix = snapshot_bucket_and_prefix(snapshot_location)
    return prefix
