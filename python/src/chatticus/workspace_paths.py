"""Map model workspace paths to host live-disk relative paths."""

from __future__ import annotations

from pathlib import PurePosixPath


def workspace_relative_path(model_path: str) -> str:
    """Return the path under the host ``workspace/`` tree for one model path.

    Model tools use absolute-style paths such as ``/workspace/research/notes.txt``.
    The host disk stores ``research/notes.txt`` under its ``workspace`` directory.

    :raises ValueError: If the path escapes the workspace tree.
    """
    normalized = model_path.strip().replace("\\", "/")
    if not normalized:
        msg = "workspace path is required"
        raise ValueError(msg)
    parts = PurePosixPath(normalized).parts
    if ".." in parts:
        msg = f"Path {model_path!r} escapes the workspace tree."
        raise ValueError(msg)
    if normalized.startswith("/workspace/"):
        relative = normalized.removeprefix("/workspace/").lstrip("/")
    elif normalized.startswith("workspace/"):
        relative = normalized.removeprefix("workspace/").lstrip("/")
    else:
        relative = normalized.lstrip("/")
    if not relative or relative.startswith(".."):
        msg = f"Path {model_path!r} escapes the workspace tree."
        raise ValueError(msg)
    return relative


def workspace_cwd_relative(model_cwd: str) -> str:
    """Return the relative directory under the host ``workspace/`` tree for one cwd.

    Model tools use ``/workspace`` or ``/workspace/research`` as working directories.

    :raises ValueError: If the path escapes the workspace tree.
    """
    normalized = model_cwd.strip().replace("\\", "/").rstrip("/")
    if not normalized:
        msg = "workspace cwd is required"
        raise ValueError(msg)
    if normalized in {"/workspace", "workspace"}:
        return ""
    return workspace_relative_path(model_cwd)
