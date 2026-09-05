"""Tests for deployment-wide operator bearer credential helpers."""

from __future__ import annotations

from chatticus.operator_credentials import (
    operator_key_configured,
    verify_operator_bearer,
)


def test_empty_operator_key_is_not_configured() -> None:
    assert not operator_key_configured("")
    assert not operator_key_configured("   ")
    assert not verify_operator_bearer("", "")
    assert not verify_operator_bearer("token", "")
    assert not verify_operator_bearer("", "configured-key")


def test_configured_operator_key_matches() -> None:
    assert verify_operator_bearer("secret-token", "secret-token")
    assert verify_operator_bearer("secret-token", "  secret-token  ")


def test_wrong_operator_token_does_not_match() -> None:
    assert not verify_operator_bearer("wrong-token", "secret-token")
