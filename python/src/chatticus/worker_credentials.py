"""Worker bearer credential minting, hashing, and HTTP parsing."""

from __future__ import annotations

import hashlib
import hmac
import secrets


def mint_worker_token() -> str:
    """Return a new random worker bearer credential."""
    return secrets.token_urlsafe(32)


def hash_worker_token(token: str) -> str:
    """Return the SHA-256 hex digest of *token*."""
    return hashlib.sha256(token.encode()).hexdigest()


def verify_worker_token_hash(token: str, token_hash: str) -> bool:
    """Return whether *token* matches the stored *token_hash*."""
    return hmac.compare_digest(hash_worker_token(token), token_hash)


def parse_bearer_token(authorization: str | None) -> str | None:
    """Extract the bearer token from an Authorization header value."""
    if authorization is None:
        return None
    scheme, _, value = authorization.partition(" ")
    if scheme.lower() != "bearer":
        return None
    token = value.strip()
    return token or None
