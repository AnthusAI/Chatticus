"""S3 adapter for computer snapshot packs.

The bucket is created by the CDK ``ChatticusSnapshots`` stack. Do not create
it with the AWS CLI.
"""

from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path
from typing import Any

from chatticus.snapshot.pack import SnapshotPackError
from chatticus.snapshot.store import SnapshotManifest
from chatticus.snapshot.uri import (
    MANIFEST_FILENAME,
    PACK_FILENAME,
    snapshot_bucket_and_prefix,
)


class S3SnapshotStore:
    """Object store backed by the CDK snapshot bucket."""

    def __init__(self, bucket: str, client: Any | None = None) -> None:
        self.bucket = bucket
        self._client = client

    @property
    def client(self) -> Any:
        """Return the boto3 S3 client, importing boto3 on first use."""
        if self._client is None:
            try:
                import boto3
            except ImportError as error:
                raise SnapshotPackError(
                    "boto3 is required for the S3 snapshot store. "
                    "Install with pip install -e '.[aws]'."
                ) from error
            self._client = boto3.client("s3")
        return self._client

    def put(self, snapshot_uri: str, pack: bytes, manifest: SnapshotManifest) -> None:
        """Upload pack and manifest to the CDK snapshot bucket."""
        bucket, prefix = self._keys(snapshot_uri)
        self.client.put_object(
            Bucket=bucket,
            Key=f"{prefix.as_posix()}/{PACK_FILENAME}",
            Body=pack,
            ContentType="application/gzip",
        )
        payload = json.dumps(asdict(manifest), indent=2, sort_keys=True) + "\n"
        self.client.put_object(
            Bucket=bucket,
            Key=f"{prefix.as_posix()}/{MANIFEST_FILENAME}",
            Body=payload.encode(),
            ContentType="application/json",
        )

    def get_pack(self, snapshot_uri: str) -> bytes:
        """Return the pack bytes for a snapshot URI."""
        bucket, prefix = self._keys(snapshot_uri)
        return self._get_bytes(bucket, f"{prefix.as_posix()}/{PACK_FILENAME}")

    def get_manifest(self, snapshot_uri: str) -> SnapshotManifest:
        """Return the manifest for a snapshot URI."""
        bucket, prefix = self._keys(snapshot_uri)
        payload = self._get_bytes(
            bucket, f"{prefix.as_posix()}/{MANIFEST_FILENAME}"
        ).decode()
        return SnapshotManifest(**json.loads(payload))

    def _keys(self, snapshot_uri: str) -> tuple[str, Path]:
        bucket, prefix = snapshot_bucket_and_prefix(snapshot_uri)
        if bucket != self.bucket:
            raise SnapshotPackError(
                f"Snapshot URI bucket {bucket!r} does not match store "
                f"bucket {self.bucket!r}."
            )
        return bucket, prefix

    def _get_bytes(self, bucket: str, key: str) -> bytes:
        try:
            response = self.client.get_object(Bucket=bucket, Key=key)
        except Exception as error:
            from botocore.exceptions import ClientError

            if isinstance(error, ClientError):
                code = error.response.get("Error", {}).get("Code", "")
                if code in {"NoSuchKey", "404"}:
                    raise SnapshotPackError(
                        f"No snapshot object s3://{bucket}/{key}."
                    ) from error
            raise
        return response["Body"].read()
