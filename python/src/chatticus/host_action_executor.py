"""Dispatch computer tool execution to workspace and browser host executors."""

from __future__ import annotations

from pathlib import Path

from chatticus.chromium_action_executor import ChromiumActionExecutor
from chatticus.snapshot.store import SnapshotObjectStore
from chatticus.terminal_action_executor import TerminalActionExecutor
from chatticus.workspace_action_executor import WorkspaceActionExecutor

_WORKSPACE_TOOLS = frozenset({"read_workspace", "write_workspace"})
_BROWSER_TOOLS = frozenset({"browser_open", "request_computer_capability"})
_TERMINAL_TOOLS = frozenset({"run_terminal"})


class HostActionExecutor:
    """Run one committed computer tool on the summoned host."""

    def __init__(
        self,
        *,
        workspace_executor: WorkspaceActionExecutor | None = None,
        browser_executor: ChromiumActionExecutor | None = None,
        terminal_executor: TerminalActionExecutor | None = None,
        live_root: Path | None = None,
        store: SnapshotObjectStore | None = None,
        display: str | None = None,
    ) -> None:
        self._workspace = workspace_executor or WorkspaceActionExecutor(
            live_root=live_root,
            store=store,
        )
        self._browser = browser_executor or ChromiumActionExecutor(display=display)
        self._terminal = terminal_executor or TerminalActionExecutor(
            live_root=live_root
        )

    def execute(self, tool_name: str, arguments: dict[str, str]) -> str:
        """Return the durable tool.result body for one host action."""
        if tool_name in _WORKSPACE_TOOLS:
            return self._workspace.execute(tool_name, arguments)
        if tool_name in _BROWSER_TOOLS:
            return self._browser.execute(tool_name, arguments)
        if tool_name in _TERMINAL_TOOLS:
            return self._terminal.execute(tool_name, arguments)
        msg = f"HostActionExecutor does not support {tool_name!r}."
        raise ValueError(msg)
