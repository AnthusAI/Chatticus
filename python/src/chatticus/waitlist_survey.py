"""Waitlist survey definition for the beta pitch page."""

from __future__ import annotations

from dataclasses import dataclass

from chatticus.models import PriceSensitivityAnswers


@dataclass(frozen=True)
class WaitlistSurveyQuestion:
    """One question in the waitlist survey."""

    question_id: str
    prompt: str


def _serialize_questions(
    questions: tuple[WaitlistSurveyQuestion, ...],
) -> list[dict[str, str]]:
    """Return question definitions for the survey API."""
    return [
        {"id": question.question_id, "prompt": question.prompt}
        for question in questions
    ]


FIT_QUESTIONS: tuple[WaitlistSurveyQuestion, ...] = (
    WaitlistSurveyQuestion(
        question_id="organization_size",
        prompt="How many people are in your organization?",
    ),
    WaitlistSurveyQuestion(
        question_id="seniority",
        prompt=("What is your role or level of seniority in the organization?"),
    ),
    WaitlistSurveyQuestion(
        question_id="urgency",
        prompt="When are you hoping to start using Chatticus?",
    ),
    WaitlistSurveyQuestion(
        question_id="work_description",
        prompt=(
            "Describe the work you want Chatticus to help with. "
            "Include enough detail that we can understand your use case."
        ),
    ),
)

AWS_READINESS_QUESTIONS: tuple[WaitlistSurveyQuestion, ...] = (
    WaitlistSurveyQuestion(
        question_id="cloud_provider",
        prompt=(
            "Which cloud provider does your organization primarily use "
            "for production workloads?"
        ),
    ),
    WaitlistSurveyQuestion(
        question_id="account_status",
        prompt=("What is the status of your AWS account for production workloads?"),
    ),
    WaitlistSurveyQuestion(
        question_id="aws_spend",
        prompt=(
            "Approximately how much does your organization spend on AWS " "per month?"
        ),
    ),
    WaitlistSurveyQuestion(
        question_id="cloud_authority",
        prompt=(
            "Who can approve cross-account IAM access and AWS changes "
            "for a new tool like Chatticus?"
        ),
    ),
    WaitlistSurveyQuestion(
        question_id="byok_readiness",
        prompt=(
            "Do you already have production API keys for the model providers "
            "you plan to use with Chatticus?"
        ),
    ),
    WaitlistSurveyQuestion(
        question_id="iam_comfort",
        prompt=(
            "How comfortable is your team with IAM roles, scoped policies, "
            "and cross-account access?"
        ),
    ),
    WaitlistSurveyQuestion(
        question_id="security_review_cycle",
        prompt=(
            "Will adopting Chatticus require a security or vendor review "
            "before you can start?"
        ),
    ),
)

SETUP_PATH_QUESTIONS: tuple[WaitlistSurveyQuestion, ...] = (
    WaitlistSurveyQuestion(
        question_id="installation_preference",
        prompt=(
            "How would you like Chatticus installed: self-install at no "
            "setup fee, or turn-key installation for a one-time fee?"
        ),
    ),
)

PROFESSIONAL_SERVICES_INTEREST_QUESTIONS: tuple[WaitlistSurveyQuestion, ...] = (
    WaitlistSurveyQuestion(
        question_id="professional_services_interest",
        prompt=(
            "Are you interested in professional services for integrating "
            "Chatticus with your custom resources?"
        ),
    ),
)

TRAINING_INTEREST_QUESTIONS: tuple[WaitlistSurveyQuestion, ...] = (
    WaitlistSurveyQuestion(
        question_id="training_interest",
        prompt=("Are you interested in professional training for your staff?"),
    ),
)

PRICE_SENSITIVITY_QUESTIONS: tuple[WaitlistSurveyQuestion, ...] = (
    WaitlistSurveyQuestion(
        question_id="too_cheap",
        prompt=(
            "At what total monthly cost — including AWS infrastructure and "
            "model token usage — would Chatticus feel so inexpensive that you "
            "would question its quality?"
        ),
    ),
    WaitlistSurveyQuestion(
        question_id="bargain",
        prompt=(
            "At what total monthly cost — including AWS and model tokens — "
            "would Chatticus feel like a bargain?"
        ),
    ),
    WaitlistSurveyQuestion(
        question_id="expensive",
        prompt=(
            "At what total monthly cost — including AWS and model tokens — "
            "would Chatticus start to feel expensive?"
        ),
    ),
    WaitlistSurveyQuestion(
        question_id="too_expensive",
        prompt=(
            "At what total monthly cost — including AWS and model tokens — "
            "would Chatticus feel too expensive?"
        ),
    ),
)


def beta_page_survey() -> dict[str, object]:
    """Return the beta page survey definition for rendering."""
    return {
        "fit": _serialize_questions(FIT_QUESTIONS),
        "aws_readiness": _serialize_questions(AWS_READINESS_QUESTIONS),
        "setup_path": _serialize_questions(SETUP_PATH_QUESTIONS),
        "price_sensitivity": _serialize_questions(PRICE_SENSITIVITY_QUESTIONS),
        "professional_services_interest": _serialize_questions(
            PROFESSIONAL_SERVICES_INTEREST_QUESTIONS
        ),
        "training_interest": _serialize_questions(TRAINING_INTEREST_QUESTIONS),
    }


def price_sensitivity_answer_keys() -> frozenset[str]:
    """Return the Van Westendorp answer keys for the price block."""
    return frozenset(
        field.name for field in PriceSensitivityAnswers.__dataclass_fields__.values()
    )
