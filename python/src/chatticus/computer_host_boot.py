"""Boot the household computer host through capability readiness gates."""

from __future__ import annotations

import os
import subprocess
import time
from dataclasses import dataclass

from chatticus.chromium_action_executor import verify_chromium_available
from chatticus.computer_capabilities import (
    BROWSER_CAPABILITY,
    MODEL_CAPABILITY,
    WORKSPACE_CAPABILITY,
)
from chatticus.control_plane import ControlPlane

_DEFAULT_DISPLAY = ":99"
_XVFB_SCREEN = "1280x720x24"


@dataclass
class ComputerHostBootResult:
    """Observed host boot progress for one household computer."""

    display: str
    chromium_version: str
    readiness_order: list[str]


class XvfbProcess:
    """Start one Xvfb display for the computer host."""

    def __init__(self, display: str = _DEFAULT_DISPLAY) -> None:
        self.display = display
        self._process: subprocess.Popen[bytes] | None = None

    def start(self) -> None:
        """Launch Xvfb when it is not already serving this display."""
        if self._process is not None and self._process.poll() is None:
            return
        command = [
            "Xvfb",
            self.display,
            "-screen",
            "0",
            _XVFB_SCREEN,
            "-nolisten",
            "tcp",
        ]
        self._process = subprocess.Popen(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        os.environ["DISPLAY"] = self.display
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            probe = subprocess.run(
                ["xdpyinfo", "-display", self.display],
                check=False,
                capture_output=True,
            )
            if probe.returncode == 0:
                return
            time.sleep(0.1)
        msg = f"Xvfb did not become ready on display {self.display!r}."
        raise RuntimeError(msg)

    def stop(self) -> None:
        """Terminate the Xvfb process when this host started it."""
        if self._process is None:
            return
        if self._process.poll() is None:
            self._process.terminate()
            try:
                self._process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._process.kill()
        self._process = None


class ComputerHostBootDriver:
    """Bring one computer host through model, workspace, and browser gates."""

    def __init__(
        self,
        plane: ControlPlane | None = None,
        *,
        tenant_id: str = "anthus",
        user_id: str = "ryan",
        display: str = _DEFAULT_DISPLAY,
        xvfb: XvfbProcess | None = None,
    ) -> None:
        self.plane = plane or ControlPlane()
        self.tenant_id = tenant_id
        self.user_id = user_id
        self.display = display
        self._xvfb = xvfb or XvfbProcess(display)
        self.readiness_order: list[str] = []
        self.last_boot: ComputerHostBootResult | None = None

    def boot_through_browser(self) -> ComputerHostBootResult:
        """Start display, verify Chromium, and record all capability gates."""
        self.plane.set_computer_stopped(self.tenant_id, False)
        self._xvfb.start()
        for capability in (MODEL_CAPABILITY, WORKSPACE_CAPABILITY):
            self.plane.record_computer_capability_ready(
                self.tenant_id, self.user_id, capability
            )
            self.readiness_order.append(capability)
        chromium_version = verify_chromium_available(display=self.display)
        self.plane.record_computer_capability_ready(
            self.tenant_id, self.user_id, BROWSER_CAPABILITY
        )
        self.readiness_order.append(BROWSER_CAPABILITY)
        result = ComputerHostBootResult(
            display=self.display,
            chromium_version=chromium_version,
            readiness_order=list(self.readiness_order),
        )
        self.last_boot = result
        return result
