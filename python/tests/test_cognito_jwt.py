"""Tests for Cognito JWKS verification."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from cognito_test_support import make_cognito_test_keys, mint_id_token

from chatticus.cognito_jwt import CognitoTokenError


@pytest.fixture
def keys() -> object:
    return make_cognito_test_keys()


def test_verify_id_token_accepts_valid_token(keys: object) -> None:
    token = mint_id_token(keys, email="Owner@Example.com")
    verified = keys.verifier().verify_id_token(token)
    assert verified.email == "owner@example.com"


def test_verify_id_token_rejects_expired_token(keys: object) -> None:
    expired = datetime(2020, 1, 1, tzinfo=UTC)
    token = mint_id_token(keys, email="owner@example.com", expires_at=expired)
    with pytest.raises(CognitoTokenError, match="expired"):
        keys.verifier().verify_id_token(token)


def test_verify_id_token_rejects_access_token(keys: object) -> None:
    token = mint_id_token(keys, email="owner@example.com", token_use="access")
    with pytest.raises(CognitoTokenError, match="access tokens"):
        keys.verifier().verify_id_token(token)


def test_verify_id_token_rejects_unverified_email(keys: object) -> None:
    token = mint_id_token(keys, email="owner@example.com", email_verified=False)
    with pytest.raises(CognitoTokenError, match="not verified"):
        keys.verifier().verify_id_token(token)


def test_jwks_refetches_on_unknown_kid(keys: object) -> None:
    verifier = keys.verifier()
    token = mint_id_token(keys, email="owner@example.com")
    verifier.verify_id_token(token)
    verifier._keys_by_kid.clear()
    verified = verifier.verify_id_token(token)
    assert verified.email == "owner@example.com"
