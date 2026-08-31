"""Kernel tests for the Chromium host action executor."""

from __future__ import annotations

from unittest.mock import patch

import pytest

from chatticus.chromium_action_executor import (
    ChromiumActionExecutor,
    chromium_binary_path,
    verify_chromium_available,
)


def test_chromium_action_executor_browser_open_returns_opened_url() -> None:
    executor = ChromiumActionExecutor(display=":99")
    with (
        patch(
            "chatticus.chromium_action_executor.chromium_binary_path",
            return_value="/usr/bin/chromium-browser",
        ),
        patch(
            "chatticus.chromium_action_executor.subprocess.run",
        ) as run,
    ):
        run.return_value.returncode = 0
        run.return_value.stdout = "<html></html>"
        run.return_value.stderr = ""
        result = executor.execute("browser_open", {"url": "https://example.test"})
    assert result == "opened:https://example.test"
    command = run.call_args.args[0]
    assert command[-1] == "https://example.test"
    assert "--headless=new" in command


def test_chromium_action_executor_maps_request_computer_capability_to_browser() -> None:
    executor = ChromiumActionExecutor(display=":99")
    with (
        patch(
            "chatticus.chromium_action_executor.chromium_binary_path",
            return_value="/usr/bin/chromium-browser",
        ),
        patch(
            "chatticus.chromium_action_executor.subprocess.run",
        ) as run,
    ):
        run.return_value.returncode = 0
        run.return_value.stdout = "<html></html>"
        run.return_value.stderr = ""
        result = executor.execute("request_computer_capability", {"gate": "browser"})
    assert result == "opened:about:blank"


def test_chromium_action_executor_refuses_unsupported_tool() -> None:
    executor = ChromiumActionExecutor(display=":99")
    with pytest.raises(ValueError, match="does not support 'browser_click'"):
        executor.execute("browser_click", {"selector": "button"})


def test_verify_chromium_available_returns_version_line() -> None:
    with (
        patch(
            "chatticus.chromium_action_executor.chromium_binary_path",
            return_value="/usr/bin/chromium-browser",
        ),
        patch(
            "chatticus.chromium_action_executor.subprocess.run",
        ) as run,
    ):
        run.return_value.returncode = 0
        run.return_value.stdout = "Chromium 120.0.0.0\n"
        run.return_value.stderr = ""
        version = verify_chromium_available(display=":99")
    assert version == "Chromium 120.0.0.0"


def test_chromium_binary_path_skips_ubuntu_snap_stub(tmp_path, monkeypatch) -> None:
    stub = tmp_path / "chromium-browser"
    stub.write_text(
        "#!/bin/sh\necho 'Command requires the chromium snap to be installed.'\n"
        "echo 'snap install chromium'\n"
    )
    stub.chmod(0o755)
    real = tmp_path / "chromium"
    real.write_text("#!/bin/sh\necho Chromium 120\n")
    real.chmod(0o755)
    monkeypatch.delenv("CHATTICUS_CHROMIUM_PATH", raising=False)

    def which(name: str) -> str | None:
        if name == "chromium-browser":
            return str(stub)
        if name == "chromium":
            return str(real)
        return None

    with patch(
        "chatticus.chromium_action_executor.shutil.which",
        side_effect=which,
    ):
        assert chromium_binary_path() == str(real)


def test_chromium_binary_path_prefers_env_override() -> None:
    with patch.dict("os.environ", {"CHATTICUS_CHROMIUM_PATH": "/opt/chromium"}):
        with patch(
            "chatticus.chromium_action_executor.shutil.which",
            return_value="/opt/chromium",
        ):
            assert chromium_binary_path() == "/opt/chromium"
