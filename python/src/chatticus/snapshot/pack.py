"""Pack and unpack a host's live computer disk."""

from __future__ import annotations

import hashlib
import io
import shutil
import tarfile
from pathlib import Path

from chatticus.browser_profiles import (
    BROWSER_PROFILES_DIRNAME,
    WORKSPACE_DIRNAME,
    ensure_browser_profiles_layout,
)

CACHE_CHECKSUM_FILENAME = ".chatticus-snapshot-checksum"

_ALLOWED_ROOTS = frozenset({WORKSPACE_DIRNAME, BROWSER_PROFILES_DIRNAME})

__all__ = [
    "BROWSER_PROFILES_DIRNAME",
    "CACHE_CHECKSUM_FILENAME",
    "SnapshotPackError",
    "WORKSPACE_DIRNAME",
    "pack_checksum",
    "pack_live_disk",
    "unpack_live_disk",
]


class SnapshotPackError(ValueError):
    """The snapshot pack is missing, corrupt, or unsafe to extract."""


def pack_checksum(pack: bytes) -> str:
    """Return the SHA-256 hex digest of a snapshot pack."""
    return hashlib.sha256(pack).hexdigest()


def pack_live_disk(live_root: Path) -> bytes:
    """Create a gzip-compressed tar of workspace and browser profiles.

    Empty directories are included so hydrate always replaces both trees.
    """
    live_root = live_root.resolve()
    live_root.mkdir(parents=True, exist_ok=True)
    ensure_browser_profiles_layout(live_root)
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for dirname in (WORKSPACE_DIRNAME, BROWSER_PROFILES_DIRNAME):
            source = live_root / dirname
            source.mkdir(parents=True, exist_ok=True)
            archive.add(source, arcname=dirname, filter=_safe_tarinfo)
    return buffer.getvalue()


def unpack_live_disk(pack: bytes, live_root: Path) -> None:
    """Replace workspace and browser profile from a snapshot pack.

    Existing trees are removed first so stale files do not survive a
    relocate onto this host.
    """
    live_root = live_root.resolve()
    live_root.mkdir(parents=True, exist_ok=True)
    _assert_pack_members_are_safe(pack)
    for dirname in (WORKSPACE_DIRNAME, BROWSER_PROFILES_DIRNAME):
        target = live_root / dirname
        if target.is_dir():
            shutil.rmtree(target)
        elif target.exists():
            target.unlink()
    with tarfile.open(fileobj=io.BytesIO(pack), mode="r:gz") as archive:
        archive.extractall(path=live_root, filter="data")


def _safe_tarinfo(tarinfo: tarfile.TarInfo) -> tarfile.TarInfo | None:
    name = tarinfo.name.replace("\\", "/").lstrip("./")
    if not _is_allowed_member_name(name):
        return None
    tarinfo.name = name
    return tarinfo


def _assert_pack_members_are_safe(pack: bytes) -> None:
    with tarfile.open(fileobj=io.BytesIO(pack), mode="r:gz") as archive:
        members = archive.getmembers()
        if not members:
            raise SnapshotPackError("Snapshot pack contains no members.")
        for member in members:
            name = member.name.replace("\\", "/").lstrip("./")
            if not _is_allowed_member_name(name):
                raise SnapshotPackError(
                    f"Snapshot pack contains a path outside the live disk: "
                    f"{member.name!r}."
                )


def _is_allowed_member_name(name: str) -> bool:
    if not name or name.startswith("/") or ".." in Path(name).parts:
        return False
    root = Path(name).parts[0]
    return root in _ALLOWED_ROOTS
