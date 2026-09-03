"""Canonical beta offer terms for waitlist signup snapshots."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime

from chatticus.models import OfferSnapshot

MANAGED_MANAGEMENT_FEE_CENTS = 2_000
TURN_KEY_INSTALLATION_FEE_CENTS = 10_000
OFFER_CONTENT_VERSION = "beta-pricing-v1"

BETA_EXPECTATIONS: tuple[str, ...] = (
    "Features change without notice.",
    "There is no uptime guarantee.",
    "The subscription can be cancelled at any time.",
    "The deployment stays in your account if you leave.",
)

PROFESSIONAL_SERVICES_TERMS = "quoted"
PROFESSIONAL_TRAINING_TERMS = "quoted"


def offer_content_hash(
    *,
    management_fee_cents: int,
    installation_fee_cents: int,
    beta_expectations: tuple[str, ...] | list[str],
    professional_services_terms: str,
    professional_training_terms: str,
    content_version: str,
) -> str:
    """Return a stable hash of offer terms excluding submission time."""
    payload = {
        "management_fee_cents": management_fee_cents,
        "installation_fee_cents": installation_fee_cents,
        "beta_expectations": list(beta_expectations),
        "professional_services_terms": professional_services_terms,
        "professional_training_terms": professional_training_terms,
        "content_version": content_version,
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def current_offer_snapshot(now: datetime) -> OfferSnapshot:
    """Return the offer terms currently shown on the beta pitch page."""
    content_hash = offer_content_hash(
        management_fee_cents=MANAGED_MANAGEMENT_FEE_CENTS,
        installation_fee_cents=TURN_KEY_INSTALLATION_FEE_CENTS,
        beta_expectations=BETA_EXPECTATIONS,
        professional_services_terms=PROFESSIONAL_SERVICES_TERMS,
        professional_training_terms=PROFESSIONAL_TRAINING_TERMS,
        content_version=OFFER_CONTENT_VERSION,
    )
    return OfferSnapshot(
        management_fee_cents=MANAGED_MANAGEMENT_FEE_CENTS,
        installation_fee_cents=TURN_KEY_INSTALLATION_FEE_CENTS,
        beta_expectations=tuple(BETA_EXPECTATIONS),
        professional_services_terms=PROFESSIONAL_SERVICES_TERMS,
        professional_training_terms=PROFESSIONAL_TRAINING_TERMS,
        created_at=now,
        content_hash=content_hash,
        content_version=OFFER_CONTENT_VERSION,
    )
