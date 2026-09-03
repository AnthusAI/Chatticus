"""Waitlist survey definition for the beta pitch page."""

from __future__ import annotations

from dataclasses import dataclass

from chatticus.models import PriceSensitivityAnswers


@dataclass(frozen=True)
class WaitlistSurveyChoice:
    """One selectable answer for a scored survey question."""

    value: str
    label: str


@dataclass(frozen=True)
class WaitlistSurveyQuestion:
    """One question in the waitlist survey."""

    question_id: str
    prompt: str
    choices: tuple[WaitlistSurveyChoice, ...] = ()
    multiline: bool = False


def _serialize_questions(
    questions: tuple[WaitlistSurveyQuestion, ...],
) -> list[dict[str, object]]:
    """Return question definitions for the survey API."""
    serialized: list[dict[str, object]] = []
    for question in questions:
        item: dict[str, object] = {
            "id": question.question_id,
            "prompt": question.prompt,
        }
        if question.choices:
            item["choices"] = [
                {"value": choice.value, "label": choice.label}
                for choice in question.choices
            ]
        if question.multiline:
            item["multiline"] = True
        serialized.append(item)
    return serialized


FIT_QUESTIONS: tuple[WaitlistSurveyQuestion, ...] = (
    WaitlistSurveyQuestion(
        question_id="organization_size",
        prompt="How many people are in your organization?",
        choices=(
            WaitlistSurveyChoice(value="1-to-5", label="1 to 5 people"),
            WaitlistSurveyChoice(value="6-to-25", label="6 to 25 people"),
            WaitlistSurveyChoice(value="26-to-100", label="26 to 100 people"),
            WaitlistSurveyChoice(value="101-plus", label="101 or more people"),
        ),
    ),
    WaitlistSurveyQuestion(
        question_id="seniority",
        prompt=("What is your role or level of seniority in the organization?"),
        choices=(
            WaitlistSurveyChoice(
                value="founder-executive-or-lead",
                label="Founder, executive, or lead",
            ),
            WaitlistSurveyChoice(value="manager", label="Manager"),
            WaitlistSurveyChoice(
                value="individual-contributor",
                label="Individual contributor",
            ),
            WaitlistSurveyChoice(value="other", label="Other"),
        ),
    ),
    WaitlistSurveyQuestion(
        question_id="urgency",
        prompt="When are you hoping to start using Chatticus?",
        choices=(
            WaitlistSurveyChoice(value="this-week", label="This week"),
            WaitlistSurveyChoice(value="this-month", label="This month"),
            WaitlistSurveyChoice(value="this-quarter", label="This quarter"),
            WaitlistSurveyChoice(value="just-exploring", label="Just exploring"),
        ),
    ),
    WaitlistSurveyQuestion(
        question_id="work_description",
        prompt=(
            "Describe the work you want Chatticus to help with. "
            "Include enough detail that we can understand your use case."
        ),
        multiline=True,
    ),
)

AWS_READINESS_QUESTIONS: tuple[WaitlistSurveyQuestion, ...] = (
    WaitlistSurveyQuestion(
        question_id="cloud_provider",
        prompt=(
            "Which cloud provider does your organization primarily use "
            "for production workloads?"
        ),
        choices=(
            WaitlistSurveyChoice(value="aws", label="AWS"),
            WaitlistSurveyChoice(value="gcp", label="Google Cloud (GCP)"),
            WaitlistSurveyChoice(value="azure", label="Microsoft Azure"),
            WaitlistSurveyChoice(value="other", label="Other"),
            WaitlistSurveyChoice(value="multi-cloud", label="Multi-cloud"),
        ),
    ),
    WaitlistSurveyQuestion(
        question_id="account_status",
        prompt=("What is the status of your AWS account for production workloads?"),
        choices=(
            WaitlistSurveyChoice(
                value="production-workloads",
                label="Production workloads on AWS",
            ),
            WaitlistSurveyChoice(
                value="staging-or-dev",
                label="Staging or development only",
            ),
            WaitlistSurveyChoice(
                value="exploring-no-production",
                label="Exploring — no production yet",
            ),
        ),
    ),
    WaitlistSurveyQuestion(
        question_id="aws_spend",
        prompt=(
            "Approximately how much does your organization spend on AWS " "per month?"
        ),
        choices=(
            WaitlistSurveyChoice(value="under-1k", label="Under $1,000"),
            WaitlistSurveyChoice(value="1k-to-10k", label="$1,000 to $10,000"),
            WaitlistSurveyChoice(value="10k-plus", label="$10,000 or more"),
            WaitlistSurveyChoice(
                value="prefer-not-to-say",
                label="Prefer not to say",
            ),
        ),
    ),
    WaitlistSurveyQuestion(
        question_id="cloud_authority",
        prompt=(
            "Who can approve cross-account IAM access and AWS changes "
            "for a new tool like Chatticus?"
        ),
        choices=(
            WaitlistSurveyChoice(value="me", label="Me"),
            WaitlistSurveyChoice(value="devops-team", label="Our DevOps team"),
            WaitlistSurveyChoice(
                value="security-or-compliance",
                label="Security or compliance",
            ),
            WaitlistSurveyChoice(
                value="procurement-or-vendor-management",
                label="Procurement or vendor management",
            ),
        ),
    ),
    WaitlistSurveyQuestion(
        question_id="byok_readiness",
        prompt=(
            "Do you already have production API keys for the model providers "
            "you plan to use with Chatticus?"
        ),
        choices=(
            WaitlistSurveyChoice(
                value="already-in-production",
                label="Already in production",
            ),
            WaitlistSurveyChoice(
                value="have-keys-not-in-production",
                label="Have keys but not in production",
            ),
            WaitlistSurveyChoice(value="will-procure", label="Will procure"),
            WaitlistSurveyChoice(value="not-yet", label="Not yet"),
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
        choices=(
            WaitlistSurveyChoice(value="yes-required", label="Yes, required"),
            WaitlistSurveyChoice(value="no-not-required", label="No, not required"),
            WaitlistSurveyChoice(value="unsure", label="Unsure"),
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
        choices=(
            WaitlistSurveyChoice(
                value="yes-with-budget",
                label="Yes, we have budget",
            ),
            WaitlistSurveyChoice(value="tell-me-more", label="Tell me more"),
            WaitlistSurveyChoice(value="not-now", label="Not now"),
            WaitlistSurveyChoice(value="no", label="No"),
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
