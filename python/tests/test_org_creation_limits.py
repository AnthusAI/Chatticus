"""Unit tests for organization creation limit helpers."""

from __future__ import annotations

import pytest

from chatticus.models import OrganizationNameTooLongError
from chatticus.org_creation_limits import (
    ORGANIZATION_NAME_MAX_LENGTH,
    validate_organization_name,
)


def test_validate_organization_name_accepts_max_length() -> None:
    name = "A" * ORGANIZATION_NAME_MAX_LENGTH
    assert validate_organization_name(name) == name


def test_validate_organization_name_strips_whitespace() -> None:
    assert validate_organization_name("  Anthus Labs  ") == "Anthus Labs"


def test_validate_organization_name_rejects_overlong_names() -> None:
    with pytest.raises(OrganizationNameTooLongError):
        validate_organization_name("A" * (ORGANIZATION_NAME_MAX_LENGTH + 1))
