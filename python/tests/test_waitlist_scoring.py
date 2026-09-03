"""Unit tests for deterministic waitlist triage scoring."""

from __future__ import annotations

from datetime import UTC, datetime

from chatticus.models import WaitlistSignup
from chatticus.waitlist_scoring import (
    SERVICES_QUALIFIED_MINIMUM_SCORE,
    WAITLIST_SCORING_WEIGHTS_VERSION,
    non_aws_cloud_provider,
    score_waitlist_signup,
)


def _signup(
    *,
    fit_answers: dict[str, str] | None = None,
    aws_readiness_answers: dict[str, str] | None = None,
    price_answers: dict[str, str] | None = None,
) -> WaitlistSignup:
    return WaitlistSignup(
        email="lead@example.com",
        fit_answers=fit_answers or {},
        aws_readiness_answers=aws_readiness_answers or {},
        price_answers=price_answers or {},
        setup_path_answers={},
        price_sensitivity_answers=None,
        complete=True,
        created_at=datetime(2026, 1, 1, tzinfo=UTC),
    )


def test_high_intent_aws_buyer_scores_services_qualified() -> None:
    result = score_waitlist_signup(
        _signup(
            fit_answers={"organization_size": "101-plus"},
            aws_readiness_answers={
                "cloud_provider": "aws",
                "account_status": "production-workloads",
                "cloud_authority": "me",
            },
            price_answers={"professional_services_interest": "yes-with-budget"},
        )
    )

    assert result.score >= SERVICES_QUALIFIED_MINIMUM_SCORE
    assert result.services_qualified is True
    assert result.weights_version == WAITLIST_SCORING_WEIGHTS_VERSION


def test_curious_individual_is_not_services_qualified() -> None:
    result = score_waitlist_signup(
        _signup(
            fit_answers={"organization_size": "1-to-5"},
            aws_readiness_answers={"account_status": "exploring-no-production"},
            price_answers={"professional_services_interest": "not-now"},
        )
    )

    assert result.services_qualified is False


def test_production_maturity_requires_aws_cloud_provider() -> None:
    without_aws = score_waitlist_signup(
        _signup(
            aws_readiness_answers={
                "cloud_provider": "gcp",
                "account_status": "production-workloads",
            }
        )
    )
    with_aws = score_waitlist_signup(
        _signup(
            aws_readiness_answers={
                "cloud_provider": "aws",
                "account_status": "production-workloads",
            }
        )
    )

    assert with_aws.score == without_aws.score + 3


def test_effort_bonus_requires_more_than_two_hundred_characters() -> None:
    short = score_waitlist_signup(_signup(fit_answers={"work_description": "x" * 200}))
    long = score_waitlist_signup(_signup(fit_answers={"work_description": "x" * 201}))

    assert long.score == short.score + 1


def test_security_review_cycle_applies_penalty() -> None:
    without_review = score_waitlist_signup(_signup())
    with_review = score_waitlist_signup(
        _signup(aws_readiness_answers={"security_review_cycle": "yes-required"})
    )

    assert with_review.score == without_review.score - 1


def test_non_aws_cloud_provider_hook() -> None:
    assert (
        non_aws_cloud_provider(_signup(aws_readiness_answers={"cloud_provider": "gcp"}))
        is True
    )
    assert (
        non_aws_cloud_provider(_signup(aws_readiness_answers={"cloud_provider": "aws"}))
        is False
    )
    assert non_aws_cloud_provider(_signup()) is False
