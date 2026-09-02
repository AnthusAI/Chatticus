"""Tests for integration-test bearer token helpers."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from chatticus.http.integration_test_auth import (
    IntegrationTestAuthConfig,
    integration_test_hmac_secret,
    mint_integration_test_token,
    mint_integration_test_token_expired,
    verify_integration_test_token,
)


def _config(*, now: datetime) -> IntegrationTestAuthConfig:
    return IntegrationTestAuthConfig(
        enabled=True,
        environment="development",
        allowed_role_arn="arn:aws:iam::123456789012:role/test",
        tenant_id="integration-test",
        user_id="integration-test-runner",
        hmac_secret=integration_test_hmac_secret("invoke-key"),
        now=lambda: now,
    )


def test_mint_and_verify_integration_test_token() -> None:
    now = datetime(2026, 9, 2, 12, 0, tzinfo=UTC)
    config = _config(now=now)
    token = mint_integration_test_token(config)
    payload = verify_integration_test_token(token, config=config)
    assert payload is not None
    assert payload["tenant_id"] == "integration-test"
    assert payload["user_id"] == "integration-test-runner"


def test_expired_integration_test_token_is_rejected() -> None:
    now = datetime(2026, 9, 2, 12, 0, tzinfo=UTC)
    config = _config(now=now + timedelta(hours=3))
    token = mint_integration_test_token_expired(config)
    assert verify_integration_test_token(token, config=config) is None
