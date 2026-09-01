"""Local RSA keys and id_token minting for Cognito resolver tests."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt.algorithms import RSAAlgorithm

from chatticus.cognito_jwt import CognitoConfig, CognitoJwtVerifier

TEST_ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_testpool"
TEST_CLIENT_ID = "test-spa-client-id"
TEST_KID = "test-key-id"


@dataclass(frozen=True)
class CognitoTestKeys:
    """One RSA keypair and JWKS payload for offline Cognito tests."""

    private_key_pem: bytes
    jwks: dict[str, Any]
    config: CognitoConfig

    def verifier(self) -> CognitoJwtVerifier:
        return CognitoJwtVerifier(self.config, fetch_jwks=lambda: self.jwks)

    @property
    def private_key(self) -> Any:
        return serialization.load_pem_private_key(self.private_key_pem, password=None)


def make_cognito_test_keys(
    *,
    issuer: str = TEST_ISSUER,
    client_id: str = TEST_CLIENT_ID,
    kid: str = TEST_KID,
) -> CognitoTestKeys:
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public_key = private_key.public_key()
    jwk = json.loads(RSAAlgorithm.to_jwk(public_key))
    jwk["kid"] = kid
    jwk["use"] = "sig"
    jwk["alg"] = "RS256"
    private_key_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    config = CognitoConfig(
        issuer=issuer,
        client_id=client_id,
        jwks_url=f"{issuer}/.well-known/jwks.json",
    )
    return CognitoTestKeys(
        private_key_pem=private_key_pem,
        jwks={"keys": [jwk]},
        config=config,
    )


def mint_id_token(
    keys: CognitoTestKeys,
    *,
    email: str,
    token_use: str = "id",
    email_verified: bool = True,
    expires_at: datetime | None = None,
    sub: str | None = None,
) -> str:
    """Mint a signed Cognito-shaped JWT for resolver tests."""
    now = datetime.now(UTC)
    exp = expires_at or (now + timedelta(hours=1))
    payload = {
        "sub": sub or str(uuid4()),
        "email": email,
        "email_verified": email_verified,
        "token_use": token_use,
        "iss": keys.config.issuer,
        "aud": keys.config.client_id,
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
    }
    return jwt.encode(
        payload,
        keys.private_key,
        algorithm="RS256",
        headers={"kid": TEST_KID},
    )
