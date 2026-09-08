"""Workspace file tools on the summoned computer host live disk."""

from __future__ import annotations

from pathlib import Path

from chatticus.host_snapshot_store import live_root_from_env, snapshot_store_from_env
from chatticus.snapshot.host import ComputerHostDisk
from chatticus.snapshot.store import FilesystemSnapshotStore, SnapshotObjectStore
from chatticus.workspace_paths import workspace_relative_path


def workspace_host_disk(
    live_root: Path | None = None,
    store: SnapshotObjectStore | None = None,
) -> ComputerHostDisk:
    """Return one host disk for workspace tool execution."""
    root = live_root if live_root is not None else live_root_from_env()
    resolved_store = store if store is not None else snapshot_store_from_env()
    if resolved_store is None:
        resolved_store = FilesystemSnapshotStore(root / ".ephemeral-snapshot")
    return ComputerHostDisk(root, resolved_store)


class WorkspaceActionExecutor:
    """Run read_workspace and write_workspace on the host live disk."""

    def __init__(
        self,
        *,
        live_root: Path | None = None,
        store: SnapshotObjectStore | None = None,
        disk: ComputerHostDisk | None = None,
    ) -> None:
        self._disk = disk or workspace_host_disk(live_root, store)

    def execute(self, tool_name: str, arguments: dict[str, str]) -> str:
        """Return the durable tool.result body for one workspace action."""
        try:
            if tool_name == "read_workspace":
                return self._read_workspace(arguments)
            if tool_name == "write_workspace":
                return self._write_workspace(arguments)
        except ValueError as error:
            return f"error: {error}"
        msg = f"WorkspaceActionExecutor does not support {tool_name!r}."
        raise ValueError(msg)

    def _read_workspace(self, arguments: dict[str, str]) -> str:
        path = arguments.get("path", "").strip()
        if not path:
            msg = "read_workspace requires path"
            raise ValueError(msg)
        relative = workspace_relative_path(path)
        try:
            content = self._disk.read_workspace_file(relative)
        except FileNotFoundError:
            return f"not found: {path}"
        except OSError as error:
            return f"error: {error}"
        return content

    def _write_workspace(self, arguments: dict[str, str]) -> str:
        path = arguments.get("path", "").strip()
        if not path:
            msg = "write_workspace requires path"
            raise ValueError(msg)
        content = arguments.get("content", "")
        relative = workspace_relative_path(path)
        self._disk.write_workspace_file(relative, content)
        return f"write_workspace:{path}"
