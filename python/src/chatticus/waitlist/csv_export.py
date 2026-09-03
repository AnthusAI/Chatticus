"""CSV export schema and row mapping for waitlist signups."""

from __future__ import annotations

import csv
import io
import json
from collections.abc import Iterable

from chatticus.models import WaitlistSignup
from chatticus.waitlist_survey import (
    AWS_READINESS_QUESTIONS,
    FIT_QUESTIONS,
    PROFESSIONAL_SERVICES_INTEREST_QUESTIONS,
    SETUP_PATH_QUESTIONS,
    TRAINING_INTEREST_QUESTIONS,
)

_CORE_COLUMNS: tuple[str, ...] = (
    "email",
    "created_at",
    "waitlist_score",
    "services_qualified",
    "disqualified",
    "scoring_weights_version",
)

_PRICE_SENSITIVITY_COLUMNS: tuple[str, ...] = (
    "price_sensitivity_too_cheap",
    "price_sensitivity_bargain",
    "price_sensitivity_expensive",
    "price_sensitivity_too_expensive",
)

_OFFER_COLUMNS: tuple[str, ...] = (
    "offer_management_fee_cents",
    "offer_installation_fee_cents",
    "offer_content_hash",
    "offer_content_version",
    "offer_professional_services_terms",
    "offer_professional_training_terms",
    "offer_beta_expectations",
)

_UTM_COLUMNS: tuple[str, ...] = (
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "utm_term",
)


def _prefixed_columns(prefix: str, question_ids: Iterable[str]) -> tuple[str, ...]:
    return tuple(f"{prefix}{question_id}" for question_id in question_ids)


WAITLIST_EXPORT_COLUMNS: tuple[str, ...] = (
    *_CORE_COLUMNS,
    *_prefixed_columns("fit_", (question.question_id for question in FIT_QUESTIONS)),
    *_prefixed_columns(
        "aws_",
        (question.question_id for question in AWS_READINESS_QUESTIONS),
    ),
    *_prefixed_columns(
        "setup_",
        (question.question_id for question in SETUP_PATH_QUESTIONS),
    ),
    *_prefixed_columns(
        "price_",
        (
            question.question_id
            for question in (
                *PROFESSIONAL_SERVICES_INTEREST_QUESTIONS,
                *TRAINING_INTEREST_QUESTIONS,
            )
        ),
    ),
    *_PRICE_SENSITIVITY_COLUMNS,
    *_OFFER_COLUMNS,
    *_UTM_COLUMNS,
)


def waitlist_signup_to_export_row(signup: WaitlistSignup) -> dict[str, str]:
    """Map one waitlist signup to a flat CSV row with stable column names."""
    row = {column: "" for column in WAITLIST_EXPORT_COLUMNS}
    row["email"] = signup.email
    row["created_at"] = signup.created_at.isoformat()
    row["waitlist_score"] = (
        str(signup.waitlist_score) if signup.waitlist_score is not None else ""
    )
    row["services_qualified"] = "true" if signup.services_qualified else "false"
    row["disqualified"] = "true" if signup.disqualified else "false"
    if signup.scoring_weights_version is not None:
        row["scoring_weights_version"] = signup.scoring_weights_version

    for question_id, answer in signup.fit_answers.items():
        row[f"fit_{question_id}"] = answer
    for question_id, answer in signup.aws_readiness_answers.items():
        row[f"aws_{question_id}"] = answer
    for question_id, answer in signup.setup_path_answers.items():
        row[f"setup_{question_id}"] = answer
    for question_id, answer in signup.price_answers.items():
        row[f"price_{question_id}"] = answer

    if signup.price_sensitivity_answers is not None:
        row["price_sensitivity_too_cheap"] = signup.price_sensitivity_answers.too_cheap
        row["price_sensitivity_bargain"] = signup.price_sensitivity_answers.bargain
        row["price_sensitivity_expensive"] = signup.price_sensitivity_answers.expensive
        row["price_sensitivity_too_expensive"] = (
            signup.price_sensitivity_answers.too_expensive
        )

    if signup.offer_snapshot is not None:
        row["offer_management_fee_cents"] = str(
            signup.offer_snapshot.management_fee_cents
        )
        row["offer_installation_fee_cents"] = str(
            signup.offer_snapshot.installation_fee_cents
        )
        row["offer_content_hash"] = signup.offer_snapshot.content_hash
        row["offer_content_version"] = signup.offer_snapshot.content_version
        row["offer_professional_services_terms"] = (
            signup.offer_snapshot.professional_services_terms
        )
        row["offer_professional_training_terms"] = (
            signup.offer_snapshot.professional_training_terms
        )
        row["offer_beta_expectations"] = json.dumps(
            list(signup.offer_snapshot.beta_expectations)
        )

    if signup.utm_source is not None:
        row["utm_source"] = signup.utm_source
    if signup.utm_medium is not None:
        row["utm_medium"] = signup.utm_medium
    if signup.utm_campaign is not None:
        row["utm_campaign"] = signup.utm_campaign
    if signup.utm_content is not None:
        row["utm_content"] = signup.utm_content
    if signup.utm_term is not None:
        row["utm_term"] = signup.utm_term

    return row


def render_waitlist_csv(signups: list[WaitlistSignup]) -> str:
    """Render waitlist signups as CSV with a stable header row."""
    buffer = io.StringIO()
    writer = csv.DictWriter(
        buffer,
        fieldnames=list(WAITLIST_EXPORT_COLUMNS),
        extrasaction="ignore",
        lineterminator="\n",
    )
    writer.writeheader()
    for signup in signups:
        writer.writerow(waitlist_signup_to_export_row(signup))
    return buffer.getvalue()
