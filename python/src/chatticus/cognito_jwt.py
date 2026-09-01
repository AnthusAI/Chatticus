"""Verify Cognito id_tokens against JWKS; identity is email-keyed, never sub."""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib.error import URLError
from urllib.request import urlopen

import jwt
from jwt.algorithms import RSAAlgorithm
from jwt.exceptions import InvalidTokenError, PyJWTError

from chatticus.models import ChatticusError
from chatticus.org_records import normalize_email


class CognitoTokenError(ChatticusError):
    """Raised when a Cognito JWT is invalid or unusable for user resolution."""


@dataclass(frozen=True)
class CognitoConfig:
    """Issuer, audience, and JWKS location for one Cognito user pool."""

    issuer: str
    client_id: str
    jwks_url: str


@dataclass(frozen=True)
class VerifiedCognitoIdentity:
    """Verified email from a Cognito id_token."""

    email: str


FetchJwks = Callable[[], dict[str, Any]]


class CognitoJwtVerifier:
    """Verify Cognito id_tokens; cache JWKS keys for Lambda warm life."""

    def __init__(
        self,
        config: CognitoConfig,
        *,
        fetch_jwks: FetchJwks | None = None,
    ) -> None:
        self._config = config
        self._fetch_jwks = fetch_jwks or self._default_fetch_jwks
        self._keys_by_kid: dict[str, Any] = {}

    @property
    def config(self) -> CognitoConfig:
        return self._config

    def verify_id_token(self, token: str) -> VerifiedCognitoIdentity:
        """Verify *token* is a valid Cognito id_token and return normalized email."""
        try:
            header = jwt.get_unverified_header(token)
        except PyJWTError as error:
            raise CognitoTokenError("Bearer token is not a valid JWT.") from error
        kid = header.get("kid")
        if not isinstance(kid, str) or not kid:
            raise CognitoTokenError("JWT header is missing kid.")

        try:
            signing_key = self._signing_key(kid)
            claims = jwt.decode(
                token,
                signing_key,
                algorithms=["RS256"],
                issuer=self._config.issuer,
                audience=self._config.client_id,
                options={"require": ["exp", "iat", "iss", "aud", "token_use"]},
            )
        except InvalidTokenError as error:
            raise CognitoTokenError(str(error)) from error

        token_use = claims.get("token_use")
        if token_use != "id":
            raise CognitoTokenError(
                "Cognito access tokens are not accepted; use id_token."
            )

        email = claims.get("email")
        if not isinstance(email, str) or not email.strip():
            raise CognitoTokenError("id_token is missing email claim.")
        if not claims.get("email_verified"):
            raise CognitoTokenError("id_token email is not verified.")

        return VerifiedCognitoIdentity(email=normalize_email(email))

    def _signing_key(self, kid: str) -> Any:
        if kid not in self._keys_by_kid:
            self._load_jwks()
        if kid not in self._keys_by_kid:
            self._load_jwks(refetch=True)
        try:
            return self._keys_by_kid[kid]
        except KeyError as error:
            raise CognitoTokenError(f"JWKS has no key for kid {kid!r}.") from error

    def _load_jwks(self, *, refetch: bool = False) -> None:
        if refetch:
            self._keys_by_kid.clear()
        payload = self._fetch_jwks()
        keys = payload.get("keys")
        if not isinstance(keys, list):
            raise CognitoTokenError("JWKS response is missing keys.")
        for jwk in keys:
            if not isinstance(jwk, dict):
                continue
            key_kid = jwk.get("kid")
            if not isinstance(key_kid, str):
                continue
            self._keys_by_kid[key_kid] = RSAAlgorithm.from_jwk(json.dumps(jwk))

    def _default_fetch_jwks(self) -> dict[str, Any]:
        try:
            with urlopen(self._config.jwks_url, timeout=10) as response:
                payload = json.loads(response.read())
        except (URLError, TimeoutError, json.JSONDecodeError) as error:
            raise CognitoTokenError(
                f"Could not fetch JWKS from {self._config.jwks_url!r}."
            ) from error
        if not isinstance(payload, dict):
            raise CognitoTokenError("JWKS response is not a JSON object.")
        return payload
