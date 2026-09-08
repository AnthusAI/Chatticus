"""Granted shell commands on the summoned computer host live disk."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

from chatticus.browser_profiles import WORKSPACE_DIRNAME
from chatticus.host_snapshot_store import live_root_from_env
from chatticus.snapshot.host import _safe_join
from chatticus.workspace_paths import workspace_cwd_relative

_SUPPORTED_TOOLS = frozenset({"run_terminal"})
_DEFAULT_CWD = "/workspace"
_DEFAULT_TIMEOUT_SECONDS = 30
_MAX_OUTPUT_BYTES = 32 * 1024
_MAX_COMMAND_LENGTH = 4096


def truncate_terminal_output(text: str, *, max_bytes: int = _MAX_OUTPUT_BYTES) -> str:
    """Return *text* truncated to at most *max_bytes* UTF-8 bytes."""
    encoded = text.encode("utf-8", errors="replace")
    if len(encoded) <= max_bytes:
        return text
    clipped = encoded[:max_bytes].decode("utf-8", errors="ignore")
    return f"{clipped}\n...[truncated]"


def resolve_terminal_cwd(live_root: Path, model_cwd: str) -> Path:
    """Return the host directory one granted terminal cwd maps to."""
    relative = workspace_cwd_relative(model_cwd)
    workspace_root = live_root / WORKSPACE_DIRNAME
    if not relative:
        return workspace_root.resolve()
    return _safe_join(workspace_root, relative)


class TerminalActionExecutor:
    """Run run_terminal on the computer host using the local shell."""

    def __init__(self, *, live_root: Path | None = None) -> None:
        self._live_root = (
            live_root if live_root is not None else live_root_from_env()
        ).resolve()

    def execute(self, tool_name: str, arguments: dict[str, str]) -> str:
        """Return the durable tool.result body for one terminal action."""
        if tool_name not in _SUPPORTED_TOOLS:
            msg = f"TerminalActionExecutor does not support {tool_name!r}."
            raise ValueError(msg)
        if tool_name == "run_terminal":
            return self._run_terminal(arguments)
        msg = f"Unsupported tool {tool_name!r}."
        raise ValueError(msg)

    def _run_terminal(self, arguments: dict[str, str]) -> str:
        command = arguments.get("command", "").strip()
        if not command:
            return "error: run_terminal requires command"
        if len(command) > _MAX_COMMAND_LENGTH:
            return f"error: command exceeds {_MAX_COMMAND_LENGTH} characters"
        model_cwd = arguments.get("cwd", _DEFAULT_CWD).strip() or _DEFAULT_CWD
        try:
            cwd = resolve_terminal_cwd(self._live_root, model_cwd)
        except ValueError as error:
            return f"error: {error}"
        if not cwd.is_dir():
            return f"error: cwd {model_cwd!r} is not a directory on the host"
        env = {
            "HOME": str(cwd),
            "PATH": os.environ.get(
                "PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
            ),
            "LANG": os.environ.get("LANG", "C.UTF-8"),
        }
        try:
            completed = subprocess.run(
                ["/bin/sh", "-c", command],
                check=False,
                capture_output=True,
                text=True,
                cwd=cwd,
                env=env,
                timeout=_DEFAULT_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired:
            return f"error: command timed out after {_DEFAULT_TIMEOUT_SECONDS} seconds"
        except OSError as error:
            return f"error: {error}"
        output = (completed.stdout or "") + (completed.stderr or "")
        body = truncate_terminal_output(output)
        return f"run_terminal:exit={completed.returncode}\n{body}"
