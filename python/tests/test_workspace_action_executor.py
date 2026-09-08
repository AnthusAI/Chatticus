"""Unit tests for the workspace action executor."""

from __future__ import annotations

from pathlib import Path

from chatticus.workspace_action_executor import WorkspaceActionExecutor


def test_workspace_executor_reads_and_writes(tmp_path: Path) -> None:
    executor = WorkspaceActionExecutor(live_root=tmp_path)
    write_body = executor.execute(
        "write_workspace",
        {
            "path": "/workspace/research/notes.txt",
            "content": "weekly",
        },
    )
    assert write_body == "write_workspace:/workspace/research/notes.txt"
    read_body = executor.execute(
        "read_workspace",
        {"path": "/workspace/research/notes.txt"},
    )
    assert read_body == "weekly"
