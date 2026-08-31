"""Per-capability readiness gates for one household computer host."""

from __future__ import annotations

from dataclasses import dataclass

MODEL_CAPABILITY = "model"
WORKSPACE_CAPABILITY = "workspace"
BROWSER_CAPABILITY = "browser"


def capability_for_computer_tool(tool_name: str) -> str:
    """Return the host readiness gate one computer tool needs."""
    if tool_name.startswith("browser") or tool_name == "request_computer_capability":
        return BROWSER_CAPABILITY
    return WORKSPACE_CAPABILITY


@dataclass
class ComputerCapabilityReadiness:
    """Per-capability readiness for one household computer host."""

    model_ready: bool = True
    workspace_ready: bool = False
    browser_ready: bool = False

    def is_ready(self, capability: str) -> bool:
        """Return whether one named capability gate has cleared."""
        if capability == MODEL_CAPABILITY:
            return self.model_ready
        if capability == WORKSPACE_CAPABILITY:
            return self.workspace_ready
        if capability == BROWSER_CAPABILITY:
            return self.browser_ready
        msg = f"Unknown capability {capability!r}."
        raise ValueError(msg)
