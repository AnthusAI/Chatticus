"""Deployment-wide operator bearer credential verification."""

from __future__ import annotations

import secrets

from chatticus.worker_credentials import parse_bearer_token

_OPERATOR_KEY_UNCONFIGURED = "operator credential required"


def operator_key_configured(operator_key: str) -> bool:
    """Return whether an operator bearer secret is configured."""
    return bool(operator_key.strip())


def verify_operator_bearer(token: str, operator_key: str) -> bool:
    """Return whether *token* matches the configured operator bearer secret."""
    if not operator_key_configured(operator_key):
        return False
    return secrets.compare_digest(token, operator_key.strip())


def operator_auth_failure_detail() -> str:
    """Return the HTTP detail when operator authentication fails."""
    return _OPERATOR_KEY_UNCONFIGURED


def parse_operator_bearer(authorization: str | None) -> str | None:
    """Extract the operator bearer token from an Authorization header value."""
    return parse_bearer_token(authorization)
