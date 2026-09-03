"""Deterministic waitlist triage scoring."""

from __future__ import annotations

from dataclasses import dataclass

from chatticus.models import WaitlistSignup

WAITLIST_SCORING_WEIGHTS_VERSION = "waitlist-weights-v1"
SERVICES_QUALIFIED_MINIMUM_SCORE = 10
_EFFORT_ANSWER_MINIMUM_LENGTH = 200


@dataclass(frozen=True)
class WaitlistScoringResult:
    """Outcome of scoring one waitlist signup."""

    score: int
    services_qualified: bool
    weights_version: str


def non_aws_cloud_provider(signup: WaitlistSignup) -> bool:
    """Return whether the signup named a non-AWS cloud provider."""
    provider = signup.aws_readiness_answers.get("cloud_provider")
    return provider is not None and provider != "aws"


def score_waitlist_signup(signup: WaitlistSignup) -> WaitlistScoringResult:
    """Compute a deterministic triage score from canonical survey answers."""
    score = 0

    services_interest = signup.price_answers.get("professional_services_interest")
    if services_interest == "yes-with-budget":
        score += 4
    elif services_interest == "tell-me-more":
        score += 2

    if signup.aws_readiness_answers.get("cloud_provider") == "aws":
        if signup.aws_readiness_answers.get("account_status") == "production-workloads":
            score += 3

    organization_size = signup.fit_answers.get("organization_size")
    if organization_size == "101-plus":
        score += 3
    elif organization_size == "26-to-100":
        score += 2

    if signup.aws_readiness_answers.get("aws_spend") == "10k-plus":
        score += 3

    cloud_authority = signup.aws_readiness_answers.get("cloud_authority")
    if cloud_authority in {"me", "devops-team"}:
        score += 2

    if signup.fit_answers.get("seniority") == "founder-executive-or-lead":
        score += 2

    urgency = signup.fit_answers.get("urgency")
    if urgency in {"this-week", "this-month"}:
        score += 2

    if signup.aws_readiness_answers.get("byok_readiness") == "already-in-production":
        score += 2

    work_description = signup.fit_answers.get("work_description", "")
    if len(work_description.strip()) > _EFFORT_ANSWER_MINIMUM_LENGTH:
        score += 1

    if signup.aws_readiness_answers.get("security_review_cycle") == "yes-required":
        score -= 1

    return WaitlistScoringResult(
        score=score,
        services_qualified=score >= SERVICES_QUALIFIED_MINIMUM_SCORE,
        weights_version=WAITLIST_SCORING_WEIGHTS_VERSION,
    )
