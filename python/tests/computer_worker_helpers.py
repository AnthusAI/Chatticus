"""Test-only helpers for computer worker specs and kernel tests."""

from __future__ import annotations

from chatticus.worker.computer import ComputerActionExecutor, FakeComputerActionExecutor


class CountingComputerActionExecutor:
    """Wrap a computer executor and count how many times it runs."""

    def __init__(self, inner: ComputerActionExecutor | None = None) -> None:
        self.inner = inner or FakeComputerActionExecutor()
        self.calls = 0
        self.last_tool_name: str | None = None
        self.last_arguments: dict[str, str] | None = None

    def execute(self, tool_name: str, arguments: dict[str, str]) -> str:
        """Count one execution, then delegate."""
        self.calls += 1
        self.last_tool_name = tool_name
        self.last_arguments = dict(arguments)
        return self.inner.execute(tool_name, arguments)
