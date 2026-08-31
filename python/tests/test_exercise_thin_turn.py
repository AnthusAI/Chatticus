"""Matchers used by the named-environment thin-turn exercise."""

from __future__ import annotations

import importlib.util
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "exercise_thin_turn.py"
_SPEC = importlib.util.spec_from_file_location("exercise_thin_turn", _SCRIPT)
assert _SPEC is not None and _SPEC.loader is not None
_EXERCISE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_EXERCISE)


def test_computer_continuation_matches_this_job() -> None:
    body = {
        "job_id": "job-1",
        "turn_id": "turn-1",
        "required_capabilities": ["computer"],
    }
    assert _EXERCISE._computer_continuation_matches(
        body, job_id="job-1", turn_id="turn-1"
    )


def test_computer_continuation_rejects_a_stale_job() -> None:
    body = {
        "job_id": "old-job",
        "turn_id": "old-turn",
        "required_capabilities": ["computer"],
    }
    assert not _EXERCISE._computer_continuation_matches(
        body, job_id="job-1", turn_id="turn-1"
    )
