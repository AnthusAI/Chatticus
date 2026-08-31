"""Live named-environment ThinTurn. Skipped in CI. Not moto."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.live_aws

_SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
_EXERCISE = _SCRIPTS / "exercise_thin_turn.py"


def test_named_thin_turn_stack_on_real_aws() -> None:
    if os.environ.get("CHATTICUS_LIVE_AWS", "").strip() != "1":
        pytest.skip(
            "Set CHATTICUS_LIVE_AWS=1 and aws login to exercise a named ThinTurn stack"
        )
    environment = (
        os.environ.get("CHATTICUS_LIVE_AWS_ENVIRONMENT", "development").strip()
        or "development"
    )
    user_id = os.environ.get("CHATTICUS_LIVE_AWS_USER_ID", "").strip() or (
        f"live-{os.getpid()}"
    )
    completed = subprocess.run(
        [
            sys.executable,
            str(_EXERCISE),
            "--environment",
            environment,
            "--user-id",
            user_id,
        ],
        check=False,
    )
    assert completed.returncode == 0
