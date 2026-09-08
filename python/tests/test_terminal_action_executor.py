"""Unit tests for the terminal host executor helpers."""

from __future__ import annotations

from pathlib import Path

import pytest

from chatticus.terminal_action_executor import (
    TerminalActionExecutor,
    resolve_terminal_cwd,
    truncate_terminal_output,
)
from chatticus.workspace_paths import workspace_cwd_relative


def test_workspace_cwd_relative_allows_workspace_root() -> None:
    assert workspace_cwd_relative("/workspace") == ""
    assert workspace_cwd_relative("workspace") == ""


def test_workspace_cwd_relative_maps_nested_directory() -> None:
    assert workspace_cwd_relative("/workspace/research") == "research"


def test_workspace_cwd_relative_rejects_escape() -> None:
    with pytest.raises(ValueError, match="escapes"):
        workspace_cwd_relative("/workspace/research/../../etc")


def test_resolve_terminal_cwd_stays_under_workspace(tmp_path: Path) -> None:
    live_root = tmp_path / "computer"
    workspace = live_root / "workspace"
    workspace.mkdir(parents=True)
    (workspace / "research").mkdir()
    resolved = resolve_terminal_cwd(live_root, "/workspace/research")
    assert resolved == (workspace / "research").resolve()


def test_truncate_terminal_output_clips_large_bodies() -> None:
    body = "x" * 100
    clipped = truncate_terminal_output(body, max_bytes=16)
    assert clipped.endswith("...[truncated]")
    assert len(clipped.encode("utf-8")) < len(body.encode("utf-8"))


def test_terminal_action_executor_runs_command(tmp_path: Path) -> None:
    live_root = tmp_path / "computer"
    workspace = live_root / "workspace"
    workspace.mkdir(parents=True)
    (workspace / "marker.txt").write_text("host-marker\n")
    executor = TerminalActionExecutor(live_root=live_root)
    result = executor.execute(
        "run_terminal",
        {"command": "cat marker.txt", "cwd": "/workspace"},
    )
    assert result.startswith("run_terminal:exit=0")
    assert "host-marker" in result


def test_terminal_action_executor_rejects_unsupported_tool(tmp_path: Path) -> None:
    executor = TerminalActionExecutor(live_root=tmp_path)
    with pytest.raises(ValueError, match="does not support"):
        executor.execute("browser_open", {"url": "https://example.com"})


def test_terminal_action_executor_rejects_bad_cwd(tmp_path: Path) -> None:
    live_root = tmp_path / "computer"
    (live_root / "workspace").mkdir(parents=True)
    executor = TerminalActionExecutor(live_root=live_root)
    result = executor.execute(
        "run_terminal",
        {
            "command": "ls .",
            "cwd": "/workspace/research/../../../../../etc",
        },
    )
    assert "error:" in result
