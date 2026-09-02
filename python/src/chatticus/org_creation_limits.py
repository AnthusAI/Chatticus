"""Limits and validation for organization creation."""

from __future__ import annotations

from datetime import timedelta

from chatticus.models import OrganizationNameTooLongError

ORGANIZATION_NAME_MAX_LENGTH = 128
ORGANIZATION_CREATION_RATE_LIMIT = 5
ORGANIZATION_CREATION_RATE_WINDOW = timedelta(hours=1)


def validate_organization_name(name: str) -> str:
    """Return the stripped organization name or raise when it is too long."""
    stripped = name.strip()
    if len(stripped) > ORGANIZATION_NAME_MAX_LENGTH:
        raise OrganizationNameTooLongError(
            f"Organization name must be at most {ORGANIZATION_NAME_MAX_LENGTH} "
            f"characters after trimming whitespace."
        )
    return stripped
