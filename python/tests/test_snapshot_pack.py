"""Tests for packing a host disk into a shared snapshot store."""

from __future__ import annotations

import io
import tarfile
from pathlib import Path

import pytest

from chatticus.control_plane import ControlPlane
from chatticus.models import CostClass, WorkerRegistration
from chatticus.snapshot.__main__ import main as snapshot_main
from chatticus.snapshot.host import ComputerHostDisk, SnapshotChecksumMismatchError
from chatticus.snapshot.pack import SnapshotPackError, pack_checksum, unpack_live_disk
from chatticus.snapshot.store import FilesystemSnapshotStore, SnapshotManifest
from chatticus.snapshot.uri import (
    SnapshotUriError,
    snapshot_object_dir,
    snapshot_uri,
)


def test_mac_hydrates_files_published_by_fargate(tmp_path: Path) -> None:
    store = FilesystemSnapshotStore(tmp_path / "store")
    fargate = ComputerHostDisk(tmp_path / "fargate", store)
    mac = ComputerHostDisk(tmp_path / "mac", store)
    fargate.write_workspace_file("projects/notes.md", "weekly")
    fargate.write_browser_profile_file("Default/Cookies", "signed-in")
    manifest = fargate.publish(
        tenant_id="anthus",
        computer_id="household-computer",
        worker_id="fargate-1",
    )
    restored = mac.hydrate(tenant_id="anthus", computer_id="household-computer")
    assert restored.checksum == manifest.checksum
    assert mac.read_workspace_file("projects/notes.md") == "weekly"
    assert mac.read_browser_profile_file("Default/Cookies") == "signed-in"


def test_hydrate_is_cache_hit_on_matching_checksum(tmp_path: Path) -> None:
    inner = FilesystemSnapshotStore(tmp_path / "store")

    class CountingStore:
        def __init__(self) -> None:
            self.downloads = 0
            self.bucket = inner.bucket

        def put(self, snapshot_uri: str, pack: bytes, manifest: object) -> None:
            inner.put(snapshot_uri, pack, manifest)

        def get_pack(self, snapshot_uri: str) -> bytes:
            self.downloads += 1
            return inner.get_pack(snapshot_uri)

        def get_manifest(self, snapshot_uri: str) -> object:
            return inner.get_manifest(snapshot_uri)

    store = CountingStore()
    fargate = ComputerHostDisk(tmp_path / "fargate", store)
    mac = ComputerHostDisk(tmp_path / "mac", store)
    fargate.write_workspace_file("notes.md", "weekly")
    fargate.publish(
        tenant_id="anthus",
        computer_id="household-computer",
        worker_id="fargate-1",
    )
    mac.hydrate(tenant_id="anthus", computer_id="household-computer")
    mac.hydrate(tenant_id="anthus", computer_id="household-computer")
    assert store.downloads == 1


def test_unpack_rejects_path_traversal(tmp_path: Path) -> None:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        data = b"nope"
        info = tarfile.TarInfo(name="../evil.txt")
        info.size = len(data)
        archive.addfile(info, io.BytesIO(data))
    with pytest.raises(SnapshotPackError):
        unpack_live_disk(buffer.getvalue(), tmp_path / "live")


def test_checksum_mismatch_is_rejected(tmp_path: Path) -> None:
    store = FilesystemSnapshotStore(tmp_path / "store")
    fargate = ComputerHostDisk(tmp_path / "fargate", store)
    fargate.write_workspace_file("notes.md", "weekly")
    fargate.publish(
        tenant_id="anthus",
        computer_id="household-computer",
        worker_id="fargate-1",
    )
    uri = snapshot_uri("anthus", "household-computer")
    pack = store.get_pack(uri)
    store.put(
        uri,
        pack,
        SnapshotManifest(
            tenant_id="anthus",
            computer_id="household-computer",
            checksum="0" * 64,
            published_by_worker_id="fargate-1",
            published_at="2026-08-30T00:00:00+00:00",
        ),
    )
    mac = ComputerHostDisk(tmp_path / "mac", store)
    with pytest.raises(SnapshotChecksumMismatchError):
        mac.hydrate(tenant_id="anthus", computer_id="household-computer")


def test_snapshot_uri_rejects_path_segments() -> None:
    with pytest.raises(SnapshotUriError):
        snapshot_uri("anthus/../other", "household-computer")
    with pytest.raises(SnapshotUriError):
        snapshot_object_dir("https://example.com/not-a-snapshot")
    prefix = snapshot_object_dir(
        "s3://other-bucket/tenants/anthus/computers/x/snapshot"
    )
    assert prefix.as_posix() == "tenants/anthus/computers/x"


def test_cli_pack_and_hydrate(tmp_path: Path) -> None:
    live = tmp_path / "fargate"
    store = tmp_path / "store"
    target = tmp_path / "mac"
    fargate = ComputerHostDisk(live, FilesystemSnapshotStore(store))
    fargate.write_workspace_file("notes.md", "from-cli")
    assert (
        snapshot_main(
            [
                "pack",
                "--live-root",
                str(live),
                "--store",
                str(store),
                "--tenant",
                "anthus",
                "--computer",
                "household-computer",
                "--worker",
                "fargate-1",
            ]
        )
        == 0
    )
    assert (
        snapshot_main(
            [
                "hydrate",
                "--live-root",
                str(target),
                "--store",
                str(store),
                "--tenant",
                "anthus",
                "--computer",
                "household-computer",
            ]
        )
        == 0
    )
    restored = ComputerHostDisk(target, FilesystemSnapshotStore(store))
    assert restored.read_workspace_file("notes.md") == "from-cli"


def test_pack_checksum_is_sha256_of_bytes() -> None:
    assert pack_checksum(b"abc") == (
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    )


def test_control_plane_records_pack_checksum(tmp_path: Path) -> None:
    plane = ControlPlane()
    plane.ensure_computer("anthus", "ryan", computer_id="household-computer")
    plane.register_worker(
        WorkerRegistration(
            worker_id="fargate-1",
            tenant_id="anthus",
            cost_class=CostClass.FARGATE,
            capabilities=frozenset({"computer"}),
            computer_id="household-computer",
        )
    )
    store = FilesystemSnapshotStore(tmp_path / "store")
    fargate = ComputerHostDisk(tmp_path / "fargate", store)
    fargate.write_workspace_file("notes.md", "weekly")
    manifest = fargate.publish(
        tenant_id="anthus",
        computer_id="household-computer",
        worker_id="fargate-1",
    )
    record = plane.publish_snapshot(
        "household-computer",
        "fargate-1",
        checksum=manifest.checksum,
    )
    assert record.checksum == manifest.checksum
    computer = plane.computer_by_id("household-computer")
    assert computer.snapshot_checksum == manifest.checksum
    assert computer.disk_dirty is False
