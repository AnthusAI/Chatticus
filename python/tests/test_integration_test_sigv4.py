"""Tests for integration-test SigV4 helpers."""

from __future__ import annotations

from chatticus.integration_test.sigv4 import (
    build_sts_get_caller_identity_headers,
    canonical_query_string,
)


def test_build_sts_get_caller_identity_headers_includes_authorization() -> None:
    headers = build_sts_get_caller_identity_headers(
        access_key="AKIAIOSFODNN7EXAMPLE",
        secret_key="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    )
    assert headers["Authorization"].startswith("AWS4-HMAC-SHA256 Credential=")
    assert headers["X-Amz-Date"]


def test_canonical_query_string_sorts_and_encodes() -> None:
    encoded = canonical_query_string(
        {
            "Version": "2011-06-15",
            "Action": "GetCallerIdentity",
        }
    )
    assert encoded == "Action=GetCallerIdentity&Version=2011-06-15"
