"""Deployment signup mode for organization creation."""

from __future__ import annotations

import os
from enum import StrEnum


class SignupMode(StrEnum):
    """Whether signed-in users may create organizations on this deployment."""

    OPEN = "open"
    INVITATION_ONLY = "invitation_only"


def parse_signup_mode(value: str | None) -> SignupMode:
    """Parse one deployment signup mode string."""
    if value is None or not value.strip():
        return SignupMode.INVITATION_ONLY
    normalized = value.strip().lower().replace("-", "_")
    if normalized == "open":
        return SignupMode.OPEN
    if normalized in {"invitation_only", "invitationonly"}:
        return SignupMode.INVITATION_ONLY
    raise ValueError(f"Unsupported signup mode: {value!r}")


def signup_mode_from_env() -> SignupMode:
    """Read signup mode from CHATTICUS_SIGNUP_MODE."""
    return parse_signup_mode(os.environ.get("CHATTICUS_SIGNUP_MODE"))
