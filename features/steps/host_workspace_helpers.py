"""Shared helpers for seeding the host workspace in Gherkin."""

from __future__ import annotations

import os
from pathlib import Path

from chatticus.workspace_action_executor import workspace_host_disk
from chatticus.workspace_paths import workspace_relative_path


def host_live_root(context: object, tenant_id: str = "anthus") -> Path:
    """Return one isolated live-disk root for the current scenario."""
    roots = getattr(context, "host_live_roots", None)
    if roots is None:
        context.host_live_roots = {}
        roots = context.host_live_roots
    if tenant_id in roots:
        live_root = roots[tenant_id]
    else:
        tmpdir = getattr(context, "snapshot_tmpdir", None)
        if tmpdir is not None:
            live_root = Path(tmpdir) / "hosts" / tenant_id
        else:
            live_root = Path(f"/tmp/chatticus-host-live-{tenant_id}")
        live_root.mkdir(parents=True, exist_ok=True)
        roots[tenant_id] = live_root
    os.environ["CHATTICUS_LIVE_ROOT"] = str(live_root)
    context.host_live_root = live_root
    return live_root


def seed_host_workspace_file(
    context: object,
    path: str,
    content: str,
    *,
    tenant_id: str = "anthus",
) -> None:
    """Write one workspace file on the host live disk."""
    disk = workspace_host_disk(live_root=host_live_root(context, tenant_id))
    disk.write_workspace_file(workspace_relative_path(path), content)
    disks = getattr(context, "host_workspace_disks", None)
    if disks is None:
        context.host_workspace_disks = {}
        disks = context.host_workspace_disks
    disks[tenant_id] = disk


def read_host_workspace_file(
    context: object,
    path: str,
    *,
    tenant_id: str = "anthus",
) -> str:
    """Read one workspace file from the host live disk."""
    disks = getattr(context, "host_workspace_disks", None)
    disk = None if disks is None else disks.get(tenant_id)
    if disk is None:
        disk = workspace_host_disk(live_root=host_live_root(context, tenant_id))
    return disk.read_workspace_file(workspace_relative_path(path))
