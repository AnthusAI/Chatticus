"""Chromium-backed computer tool execution on the household computer host."""

from __future__ import annotations

import os
import shutil
import subprocess
from collections.abc import Sequence

_SUPPORTED_TOOLS = frozenset({"browser_open", "request_computer_capability"})


def chromium_binary_path() -> str:
    """Return the Chromium executable on this host."""
    for candidate in (
        os.environ.get("CHATTICUS_CHROMIUM_PATH", "").strip(),
        "chromium-browser",
        "chromium",
        "google-chrome",
    ):
        if not candidate:
            continue
        resolved = shutil.which(candidate)
        if resolved:
            return resolved
    msg = "Chromium executable was not found on this host."
    raise FileNotFoundError(msg)


def verify_chromium_available(
    *,
    display: str | None = None,
    extra_args: Sequence[str] | None = None,
) -> str:
    """Probe Chromium on the configured display and return its version line."""
    env = os.environ.copy()
    if display:
        env["DISPLAY"] = display
    command = [chromium_binary_path(), "--version"]
    if extra_args:
        command.extend(extra_args)
    completed = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()
        msg = f"Chromium probe failed: {detail or completed.returncode}"
        raise RuntimeError(msg)
    version = (completed.stdout or completed.stderr or "").strip().splitlines()[0]
    return version


class ChromiumActionExecutor:
    """Run browser_open on the computer host using the local Chromium binary."""

    def __init__(self, *, display: str | None = None) -> None:
        self._display = display or os.environ.get("DISPLAY", "").strip() or None

    def execute(self, tool_name: str, arguments: dict[str, str]) -> str:
        """Return the durable tool.result body for one browser action."""
        if tool_name not in _SUPPORTED_TOOLS:
            msg = f"ChromiumActionExecutor does not support {tool_name!r}."
            raise ValueError(msg)
        if tool_name == "browser_open":
            return self._browser_open(arguments)
        if tool_name == "request_computer_capability":
            gate = arguments.get("gate", "browser").strip() or "browser"
            if gate != "browser":
                msg = (
                    "ChromiumActionExecutor only opens the browser for "
                    f"request_computer_capability gate {gate!r}."
                )
                raise ValueError(msg)
            url = arguments.get("url", "").strip() or "about:blank"
            return self._browser_open({"url": url})
        msg = f"Unsupported tool {tool_name!r}."
        raise ValueError(msg)

    def _browser_open(self, arguments: dict[str, str]) -> str:
        url = arguments.get("url", "about:blank").strip() or "about:blank"
        env = os.environ.copy()
        if self._display:
            env["DISPLAY"] = self._display
        command = [
            chromium_binary_path(),
            "--headless=new",
            "--no-sandbox",
            "--disable-gpu",
            "--disable-dev-shm-usage",
            f"--user-data-dir={self._browser_profile_dir()}",
            "--dump-dom",
            url,
        ]
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            env=env,
            timeout=60,
        )
        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout or "").strip()
            msg = f"browser_open failed for {url!r}: {detail or completed.returncode}"
            raise RuntimeError(msg)
        return f"opened:{url}"

    def _browser_profile_dir(self) -> str:
        live_root = os.environ.get(
            "CHATTICUS_LIVE_ROOT", "/var/lib/chatticus/computer"
        ).rstrip("/")
        return f"{live_root}/browser-profile"
