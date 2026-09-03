"""Waitlist survey definition for the beta pitch page."""

from __future__ import annotations

from dataclasses import dataclass

from chatticus.models import PriceSensitivityAnswers


@dataclass(frozen=True)
class WaitlistSurveyQuestion:
    """One question in the waitlist survey."""

    question_id: str
    prompt: str


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
        "price_sensitivity": [
            {"id": question.question_id, "prompt": question.prompt}
            for question in PRICE_SENSITIVITY_QUESTIONS
        ]
    }


def price_sensitivity_answer_keys() -> frozenset[str]:
    """Return the Van Westendorp answer keys for the price block."""
    return frozenset(
        field.name for field in PriceSensitivityAnswers.__dataclass_fields__.values()
    )
