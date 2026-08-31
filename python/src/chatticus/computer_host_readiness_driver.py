"""Drive per-capability readiness on the computer host."""

from __future__ import annotations

from chatticus.computer_capabilities import (
    BROWSER_CAPABILITY,
    MODEL_CAPABILITY,
    WORKSPACE_CAPABILITY,
)
from chatticus.control_plane import ControlPlane


class ComputerHostReadinessDriver:
    """Record capability gates clearing independently during host boot."""

    def __init__(self, plane: ControlPlane | None = None) -> None:
        self.plane = plane or ControlPlane()
        self.tenant_id = "anthus"
        self.user_id = "ryan"
        self.readiness_order: list[str] = []

    def given_stopped_computer(self) -> None:
        """Ensure the household computer exists and is stopped."""
        self.plane.set_computer_stopped(self.tenant_id, self.user_id, True)

    def boot_through_workspace(self) -> None:
        """Clear model and workspace gates, leaving browser cold."""
        for capability in (MODEL_CAPABILITY, WORKSPACE_CAPABILITY):
            self.plane.record_computer_capability_ready(
                self.tenant_id, self.user_id, capability
            )
            self.readiness_order.append(capability)

    def clear_browser_gate(self) -> None:
        """Clear the browser readiness gate."""
        self.plane.record_computer_capability_ready(
            self.tenant_id, self.user_id, BROWSER_CAPABILITY
        )
        self.readiness_order.append(BROWSER_CAPABILITY)

    def readiness(self) -> object:
        """Return the computer's recorded capability readiness."""
        return self.plane.computer_capability_readiness(self.tenant_id, self.user_id)
