"""Tests for waitlist CLI formatting helpers."""

from __future__ import annotations

from datetime import UTC, datetime

from chatticus.models import WaitlistSignup
from chatticus.waitlist.formatting import sort_waitlist_by_score_desc

_NOW = datetime(2026, 9, 1, 12, 0, 0, tzinfo=UTC)


def _signup(
    email: str,
    *,
    waitlist_score: int | None,
    created_at: datetime = _NOW,
) -> WaitlistSignup:
    return WaitlistSignup(
        email=email,
        fit_answers={},
        aws_readiness_answers={},
        price_answers={},
        setup_path_answers={},
        price_sensitivity_answers=None,
        complete=True,
        created_at=created_at,
        email_confirmed=True,
        waitlist_score=waitlist_score,
    )


def test_sort_waitlist_by_score_desc_orders_scored_signups_first() -> None:
    signups = [
        _signup("unscored@example.com", waitlist_score=None),
        _signup("high@example.com", waitlist_score=12),
        _signup("low@example.com", waitlist_score=3),
    ]
    ordered = sort_waitlist_by_score_desc(signups)
    assert [signup.email for signup in ordered] == [
        "high@example.com",
        "low@example.com",
        "unscored@example.com",
    ]


def test_sort_waitlist_by_score_desc_puts_unscored_after_all_scores() -> None:
    signups = [
        _signup("score-one@example.com", waitlist_score=1),
        _signup("unscored@example.com", waitlist_score=None),
    ]
    ordered = sort_waitlist_by_score_desc(signups)
    assert ordered[-1].email == "unscored@example.com"
