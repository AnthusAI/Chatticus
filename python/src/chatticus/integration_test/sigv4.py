"""SigV4 helpers for integration-test session exchange."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from urllib.parse import quote

from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.credentials import Credentials

STS_GET_CALLER_IDENTITY_URL = "https://sts.amazonaws.com/"
STS_GET_CALLER_IDENTITY_QUERY = "Action=GetCallerIdentity&Version=2011-06-15"


def build_sts_get_caller_identity_headers(
    *,
    access_key: str,
    secret_key: str,
    session_token: str | None = None,
    region: str = "us-east-1",
) -> dict[str, str]:
    """Return SigV4 headers for one unsigned STS GetCallerIdentity GET."""
    credentials = Credentials(access_key, secret_key, token=session_token)
    request = AWSRequest(
        method="GET",
        url=f"{STS_GET_CALLER_IDENTITY_URL}?{STS_GET_CALLER_IDENTITY_QUERY}",
        headers={"Host": "sts.amazonaws.com"},
    )
    SigV4Auth(credentials, "sts", region).add_auth(request)
    return dict(request.headers.items())


def build_sts_get_caller_identity_headers_from_session(
    session: Any,
    *,
    region: str = "us-east-1",
) -> dict[str, str]:
    """Return SigV4 headers using one boto3 session's frozen credentials."""
    frozen = session.get_credentials().get_frozen_credentials()
    return build_sts_get_caller_identity_headers(
        access_key=frozen.access_key,
        secret_key=frozen.secret_key,
        session_token=frozen.token,
        region=region,
    )


def canonical_query_string(params: Mapping[str, str]) -> str:
    """Return the SigV4 canonical query string for *params*."""
    encoded = []
    for key in sorted(params):
        encoded.append(f"{quote(key, safe='')}={quote(params[key], safe='')}")
    return "&".join(encoded)
