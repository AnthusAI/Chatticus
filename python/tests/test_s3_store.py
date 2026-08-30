"""S3 snapshot store against moto, and the CDK bucket when deployed."""

from __future__ import annotations

import os
from pathlib import Path

import boto3
import pytest
from moto import mock_aws

from chatticus.snapshot.host import ComputerHostDisk
from chatticus.snapshot.pack import SnapshotPackError
from chatticus.snapshot.s3 import S3SnapshotStore
from chatticus.snapshot.store import open_snapshot_store
from chatticus.snapshot.uri import snapshot_uri


def test_open_s3_store_requires_cdk_bucket_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("CHATTICUS_SNAPSHOT_BUCKET", raising=False)
    with pytest.raises(SnapshotPackError, match="CHATTICUS_SNAPSHOT_BUCKET"):
        open_snapshot_store("s3")


@mock_aws
def test_s3_store_roundtrip_between_hosts(tmp_path: Path) -> None:
    bucket = "chatticus-snapshots-test"
    client = boto3.client("s3", region_name="us-east-1")
    client.create_bucket(Bucket=bucket)
    store = S3SnapshotStore(bucket, client=client)
    fargate = ComputerHostDisk(tmp_path / "fargate", store)
    mac = ComputerHostDisk(tmp_path / "mac", store)
    fargate.write_workspace_file("notes.md", "from-fargate")
    fargate.write_browser_profile_file("Default/Cookies", "signed-in")
    manifest = fargate.publish(
        tenant_id="anthus",
        computer_id="household-computer",
        worker_id="fargate-1",
    )
    uri = snapshot_uri("anthus", "household-computer", bucket=bucket)
    assert client.get_object(
        Bucket=bucket,
        Key="tenants/anthus/computers/household-computer/snapshot.tar.gz",
    )
    restored = mac.hydrate(tenant_id="anthus", computer_id="household-computer")
    assert restored.checksum == manifest.checksum
    assert mac.read_workspace_file("notes.md") == "from-fargate"
    assert mac.read_browser_profile_file("Default/Cookies") == "signed-in"
    assert store.get_manifest(uri).published_by_worker_id == "fargate-1"


@mock_aws
def test_s3_missing_pack_raises(tmp_path: Path) -> None:
    bucket = "chatticus-snapshots-test"
    client = boto3.client("s3", region_name="us-east-1")
    client.create_bucket(Bucket=bucket)
    store = S3SnapshotStore(bucket, client=client)
    mac = ComputerHostDisk(tmp_path / "mac", store)
    with pytest.raises(SnapshotPackError):
        mac.hydrate(tenant_id="anthus", computer_id="missing")


@pytest.mark.skipif(
    not os.environ.get("CHATTICUS_SNAPSHOT_BUCKET"),
    reason="Set CHATTICUS_SNAPSHOT_BUCKET to the CDK SnapshotBucketName output",
)
def test_cdk_bucket_roundtrip(tmp_path: Path) -> None:
    bucket = os.environ["CHATTICUS_SNAPSHOT_BUCKET"]
    store = S3SnapshotStore(bucket)
    fargate = ComputerHostDisk(tmp_path / "fargate", store)
    mac = ComputerHostDisk(tmp_path / "mac", store)
    fargate.write_workspace_file("live-check.md", "cdk-s3")
    fargate.publish(
        tenant_id="anthus",
        computer_id="cdk-live-check",
        worker_id="fargate-1",
    )
    mac.hydrate(tenant_id="anthus", computer_id="cdk-live-check")
    assert mac.read_workspace_file("live-check.md") == "cdk-s3"
