"""Step definitions for host-disk snapshot packs."""

from __future__ import annotations

from pathlib import Path

from behave import given, then, when

from chatticus.snapshot.host import ComputerHostDisk
from chatticus.snapshot.store import FilesystemSnapshotStore
from chatticus.snapshot.uri import PACK_FILENAME, snapshot_object_dir, snapshot_uri


class CountingSnapshotStore:
    """Filesystem store that counts pack downloads."""

    def __init__(self, inner: FilesystemSnapshotStore) -> None:
        self.inner = inner
        self.pack_downloads = 0
        self.bucket = inner.bucket

    def put(self, snapshot_uri: str, pack: bytes, manifest: object) -> None:
        self.inner.put(snapshot_uri, pack, manifest)

    def get_pack(self, snapshot_uri: str) -> bytes:
        self.pack_downloads += 1
        return self.inner.get_pack(snapshot_uri)

    def get_manifest(self, snapshot_uri: str) -> object:
        return self.inner.get_manifest(snapshot_uri)


@given("a filesystem snapshot store")
def given_filesystem_store(context: object) -> None:
    root = Path(context.snapshot_tmpdir)
    context.snapshot_store = CountingSnapshotStore(
        FilesystemSnapshotStore(root / "store")
    )
    context.computer_hosts = {}


@given('a computer host named "{name}"')
def given_computer_host(context: object, name: str) -> None:
    live_root = Path(context.snapshot_tmpdir) / "hosts" / name
    context.computer_hosts[name] = ComputerHostDisk(live_root, context.snapshot_store)


@when('host "{name}" writes workspace file "{path}" containing "{content}"')
def when_host_writes_workspace(
    context: object, name: str, path: str, content: str
) -> None:
    context.computer_hosts[name].write_workspace_file(path, content)


@when('host "{name}" writes browser profile file "{path}" containing "{content}"')
def when_host_writes_browser_profile(
    context: object, name: str, path: str, content: str
) -> None:
    context.computer_hosts[name].write_browser_profile_file(path, content)


@when(
    'host "{name}" publishes computer "{computer_id}" for tenant "{tenant_id}" '
    'as worker "{worker_id}"'
)
def when_host_publishes(
    context: object,
    name: str,
    computer_id: str,
    tenant_id: str,
    worker_id: str,
) -> None:
    context.last_manifest = context.computer_hosts[name].publish(
        tenant_id=tenant_id,
        computer_id=computer_id,
        worker_id=worker_id,
    )


@when('host "{name}" hydrates computer "{computer_id}" for tenant "{tenant_id}"')
def when_host_hydrates(
    context: object, name: str, computer_id: str, tenant_id: str
) -> None:
    context.computer_hosts[name].hydrate(tenant_id=tenant_id, computer_id=computer_id)


@then('the snapshot store has a pack for tenant "{tenant_id}" computer "{computer_id}"')
def then_store_has_pack(context: object, tenant_id: str, computer_id: str) -> None:
    uri = snapshot_uri(tenant_id, computer_id)
    pack = context.snapshot_store.inner.root / snapshot_object_dir(uri) / PACK_FILENAME
    assert pack.is_file()
    assert pack.stat().st_size > 0


@then('host "{name}" has workspace file "{path}" containing "{content}"')
def then_host_workspace(context: object, name: str, path: str, content: str) -> None:
    assert context.computer_hosts[name].read_workspace_file(path) == content


@then('host "{name}" has browser profile file "{path}" containing "{content}"')
def then_host_browser_profile(
    context: object, name: str, path: str, content: str
) -> None:
    assert context.computer_hosts[name].read_browser_profile_file(path) == content


@then('host "{name}" does not have workspace file "{path}"')
def then_host_missing_workspace(context: object, name: str, path: str) -> None:
    from chatticus.snapshot.pack import WORKSPACE_DIRNAME

    live = context.computer_hosts[name].live_root / WORKSPACE_DIRNAME / path
    assert not live.exists()


@then("the snapshot store served {count:d} pack download")
def then_pack_downloads_one(context: object, count: int) -> None:
    assert context.snapshot_store.pack_downloads == count
