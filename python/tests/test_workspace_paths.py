"""Unit tests for workspace path normalization."""

from __future__ import annotations

import pytest

from chatticus.workspace_paths import workspace_relative_path


def test_workspace_relative_path_strips_workspace_prefix() -> None:
    assert (
        workspace_relative_path("/workspace/research/notes.txt") == "research/notes.txt"
    )


def test_workspace_relative_path_accepts_bare_relative() -> None:
    assert workspace_relative_path("notes.md") == "notes.md"


def test_workspace_relative_path_rejects_escape() -> None:
    with pytest.raises(ValueError, match="escapes"):
        workspace_relative_path("/workspace/../../../etc/passwd")
