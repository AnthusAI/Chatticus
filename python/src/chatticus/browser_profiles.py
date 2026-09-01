"""Map policy storage partitions to on-disk Chromium user-data directories."""

from __future__ import annotations

import re
from pathlib import Path

WORKSPACE_DIRNAME = "workspace"
BROWSER_PROFILES_DIRNAME = "browser-profiles"
LEGACY_BROWSER_PROFILE_DIRNAME = "browser-profile"
UNTRUSTED_PARTITION = "untrusted"
PRIVILEGED_PARTITION_PREFIX = "privileged:"
LEGACY_PRIVILEGED_DIRNAME = "_legacy"
_SERVICE_NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]*$")


def browser_profile_dir(live_root: str | Path, storage_partition: str) -> Path:
    """Return the Chromium user-data directory for one storage partition."""
    root = Path(live_root).resolve()
    partition = storage_partition.strip() or UNTRUSTED_PARTITION
    if partition == UNTRUSTED_PARTITION:
        return root / BROWSER_PROFILES_DIRNAME / UNTRUSTED_PARTITION
    if partition.startswith(PRIVILEGED_PARTITION_PREFIX):
        service = partition[len(PRIVILEGED_PARTITION_PREFIX) :]
        if not service or not _SERVICE_NAME_RE.fullmatch(service):
            msg = f"invalid privileged storage partition {storage_partition!r}"
            raise ValueError(msg)
        return root / BROWSER_PROFILES_DIRNAME / "privileged" / service
    msg = f"unknown storage partition {storage_partition!r}"
    raise ValueError(msg)


def migrate_legacy_browser_profile(live_root: str | Path) -> None:
    """Move a legacy singular browser profile into the partitioned tree once."""
    root = Path(live_root).resolve()
    legacy = root / LEGACY_BROWSER_PROFILE_DIRNAME
    profiles_root = root / BROWSER_PROFILES_DIRNAME
    if not legacy.exists() or profiles_root.exists():
        return
    target = profiles_root / "privileged" / LEGACY_PRIVILEGED_DIRNAME
    target.parent.mkdir(parents=True, exist_ok=True)
    legacy.rename(target)


def ensure_browser_profiles_layout(live_root: str | Path) -> None:
    """Create partitioned browser profile directories on one host."""
    root = Path(live_root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    migrate_legacy_browser_profile(root)
    (root / BROWSER_PROFILES_DIRNAME / UNTRUSTED_PARTITION).mkdir(
        parents=True, exist_ok=True
    )
    (root / BROWSER_PROFILES_DIRNAME / "privileged").mkdir(parents=True, exist_ok=True)
