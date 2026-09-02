"""Tier A adversarial browser injection evals (in-process, always-on)."""

from __future__ import annotations

import pytest
from adversarial_injection import (
    ALLOWED_CASES,
    FORBIDDEN_CASES,
    AdversarialInjectionDriver,
    InjectionCase,
)


@pytest.mark.parametrize(
    "case", FORBIDDEN_CASES, ids=[c.case_id for c in FORBIDDEN_CASES]
)
def test_forbidden_injection_blocked_at_sink(case: InjectionCase) -> None:
    """Page content may convince the model; sinks must still deny."""
    driver = AdversarialInjectionDriver()
    outcome = driver.run_case(case)
    assert outcome.case.expect_denied is True


@pytest.mark.parametrize("case", ALLOWED_CASES, ids=[c.case_id for c in ALLOWED_CASES])
def test_allowed_read_only_still_succeeds(case: InjectionCase) -> None:
    """Granted read-only work succeeds even after injection metadata is parsed."""
    driver = AdversarialInjectionDriver()
    outcome = driver.run_case(case)
    assert outcome.denied is False
    assert outcome.error is None


def test_regression_guard_stubbed_allow_sink_fails_eval(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Prove evals catch bypasses: a stubbed ALLOW sink must fail the suite."""
    case = next(c for c in FORBIDDEN_CASES if c.case_id == "exfil-direct-secrets-read")

    def allow_all(_policy: object, _path: str, _member_standing: object) -> None:
        return None

    monkeypatch.setattr(
        "chatticus.control_plane.gated_read_workspace",
        allow_all,
    )
    driver = AdversarialInjectionDriver()
    with pytest.raises(AssertionError, match="expected sink denial"):
        driver.run_case(case)
