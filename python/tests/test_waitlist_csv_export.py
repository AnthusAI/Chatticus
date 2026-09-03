"""Tests for waitlist CSV export helpers."""

from __future__ import annotations

import csv
import io
from datetime import UTC, datetime

from chatticus.models import OfferSnapshot, PriceSensitivityAnswers, WaitlistSignup
from chatticus.waitlist.csv_export import (
    WAITLIST_EXPORT_COLUMNS,
    render_waitlist_csv,
    waitlist_signup_to_export_row,
)

_NOW = datetime(2026, 9, 1, 12, 0, 0, tzinfo=UTC)
_OFFER = OfferSnapshot(
    management_fee_cents=2_000,
    installation_fee_cents=10_000,
    beta_expectations=("Features change without notice.",),
    professional_services_terms="quoted",
    professional_training_terms="quoted",
    created_at=_NOW,
    content_hash="offer-hash",
    content_version="beta-pricing-v1",
)


def _sample_signup(**overrides: object) -> WaitlistSignup:
    signup = WaitlistSignup(
        email="sample@example.com",
        fit_answers={
            "organization_size": "26-to-100",
            "work_description": (
                'Needs help with "quotes", commas, and newlines.\nThanks.'
            ),
        },
        aws_readiness_answers={"cloud_provider": "aws"},
        price_answers={
            "professional_services_interest": "tell-me-more",
            "training_interest": "yes-with-budget",
        },
        setup_path_answers={"installation_preference": "self-install"},
        price_sensitivity_answers=PriceSensitivityAnswers(
            too_cheap="15",
            bargain="35",
            expensive="90",
            too_expensive="175",
        ),
        complete=True,
        created_at=_NOW,
        email_confirmed=True,
        offer_snapshot=_OFFER,
        waitlist_score=8,
        services_qualified=False,
        scoring_weights_version="waitlist-weights-v1",
        disqualified=False,
    )
    if overrides:
        return WaitlistSignup(**{**signup.__dict__, **overrides})
    return signup


def test_waitlist_export_columns_are_stable() -> None:
    assert "price_training_interest" in WAITLIST_EXPORT_COLUMNS
    assert WAITLIST_EXPORT_COLUMNS.index("email") < WAITLIST_EXPORT_COLUMNS.index(
        "fit_organization_size"
    )
    assert WAITLIST_EXPORT_COLUMNS.index(
        "price_professional_services_interest"
    ) < WAITLIST_EXPORT_COLUMNS.index("price_training_interest")
    assert WAITLIST_EXPORT_COLUMNS.index(
        "price_training_interest"
    ) < WAITLIST_EXPORT_COLUMNS.index("price_sensitivity_too_cheap")


def test_waitlist_signup_to_export_row_maps_known_fields() -> None:
    row = waitlist_signup_to_export_row(_sample_signup())
    assert row["email"] == "sample@example.com"
    assert row["fit_organization_size"] == "26-to-100"
    assert row["aws_cloud_provider"] == "aws"
    assert row["price_professional_services_interest"] == "tell-me-more"
    assert row["price_training_interest"] == "yes-with-budget"
    assert row["price_sensitivity_bargain"] == "35"
    assert row["offer_content_hash"] == "offer-hash"
    assert row["waitlist_score"] == "8"
    assert row["disqualified"] == "false"


def test_waitlist_signup_to_export_row_leaves_missing_answers_empty() -> None:
    row = waitlist_signup_to_export_row(
        _sample_signup(
            fit_answers={},
            aws_readiness_answers={},
            price_answers={},
            setup_path_answers={},
            price_sensitivity_answers=None,
            offer_snapshot=None,
            waitlist_score=None,
            scoring_weights_version=None,
        )
    )
    assert row["fit_organization_size"] == ""
    assert row["price_training_interest"] == ""
    assert row["price_sensitivity_bargain"] == ""
    assert row["offer_content_hash"] == ""
    assert row["waitlist_score"] == ""
    assert row["scoring_weights_version"] == ""


def test_render_waitlist_csv_quotes_free_text_and_keeps_header() -> None:
    csv_text = render_waitlist_csv([_sample_signup()])
    rows = list(csv.DictReader(io.StringIO(csv_text)))
    assert list(rows[0].keys()) == list(WAITLIST_EXPORT_COLUMNS)
    assert "\n" in rows[0]["fit_work_description"] or '"' in csv_text
