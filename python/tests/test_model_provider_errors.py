"""Classify model provider failures as permanent or temporary."""

from __future__ import annotations

import httpx

from chatticus.worker.model_provider_errors import (
    ACCESS_DENIED_REASON,
    INVALID_REQUEST_REASON,
    OUT_OF_QUOTA_REASON,
    REJECTED_KEY_REASON,
    is_model_provider_error,
    permanent_model_provider_failure,
)

_REQUEST = httpx.Request("POST", "https://api.openai.com/v1/chat/completions")


def _status_error(status: int, **response_kwargs: object) -> httpx.HTTPStatusError:
    response = httpx.Response(status, request=_REQUEST, **response_kwargs)
    return httpx.HTTPStatusError("provider error", request=_REQUEST, response=response)


def test_quota_exhaustion_is_permanent() -> None:
    error = _status_error(429, json={"error": {"code": "insufficient_quota"}})
    failure = permanent_model_provider_failure(error)
    assert failure is not None
    assert failure.reason == OUT_OF_QUOTA_REASON


def test_rate_limiting_without_a_quota_code_is_temporary() -> None:
    assert (
        permanent_model_provider_failure(
            _status_error(429, json={"error": {"code": "rate_limit_exceeded"}})
        )
        is None
    )
    assert permanent_model_provider_failure(_status_error(429, text="busy")) is None


def _provider_error(status: int, code: str) -> httpx.HTTPStatusError:
    return _status_error(status, json={"error": {"code": code}})


def test_rejected_credentials_denied_access_and_invalid_requests_are_permanent() -> (
    None
):
    assert permanent_model_provider_failure(
        _provider_error(401, "invalid_api_key")
    ).reason == (REJECTED_KEY_REASON)
    assert permanent_model_provider_failure(
        _provider_error(403, "unsupported_country_region_territory")
    ).reason == (ACCESS_DENIED_REASON)
    assert permanent_model_provider_failure(
        _provider_error(400, "unsupported_value")
    ).reason == (INVALID_REQUEST_REASON)
    assert permanent_model_provider_failure(
        _provider_error(404, "model_not_found")
    ).reason == (INVALID_REQUEST_REASON)


def test_client_errors_without_a_provider_error_body_are_temporary() -> None:
    assert permanent_model_provider_failure(_status_error(403, text="<html/>")) is None
    assert permanent_model_provider_failure(_status_error(400)) is None


def test_server_errors_and_network_faults_are_temporary() -> None:
    assert permanent_model_provider_failure(_status_error(503)) is None
    timeout = httpx.ReadTimeout("slow", request=_REQUEST)
    assert permanent_model_provider_failure(timeout) is None
    assert is_model_provider_error(timeout)


def test_errors_that_are_not_provider_responses_are_not_classified() -> None:
    error = RuntimeError("Model returned an empty completion.")
    assert not is_model_provider_error(error)
    assert permanent_model_provider_failure(error) is None
