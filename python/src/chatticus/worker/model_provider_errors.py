"""Classify model provider failures as permanent or temporary.

A permanent failure cannot succeed on retry (no quota, a rejected key, an
invalid request), so the turn should fail at once with a reason a person can
act on. A temporary failure (rate limiting, an unavailable provider, a
network fault) should leave the turn for the queue to retry.
"""

from __future__ import annotations

from dataclasses import dataclass

import httpx

OUT_OF_QUOTA_REASON = (
    "The model provider refused the request: "
    "the account is out of credits or over its quota."
)
REJECTED_KEY_REASON = "The model provider rejected the API key."
INVALID_REQUEST_REASON = "The model provider rejected the request as invalid."


class TemporaryModelProviderError(RuntimeError):
    """A model call failed in a way a later retry may fix."""


@dataclass(frozen=True)
class PermanentModelProviderFailure:
    """A model call failure that no retry can fix, with a readable reason."""

    reason: str


def _provider_error_code(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        return ""
    error = payload.get("error") if isinstance(payload, dict) else None
    if not isinstance(error, dict):
        return ""
    return str(error.get("code") or error.get("type") or "")


def permanent_model_provider_failure(
    error: Exception,
) -> PermanentModelProviderFailure | None:
    """Return the permanent failure ``error`` represents, if any.

    :param error: The exception raised by the model call.
    :returns: The permanent failure with a member-facing reason, or ``None``
        for temporary failures and errors that are not provider responses.
    """
    if not isinstance(error, httpx.HTTPStatusError):
        return None
    status = error.response.status_code
    code = _provider_error_code(error.response)
    if status == 429 and code == "insufficient_quota":
        return PermanentModelProviderFailure(OUT_OF_QUOTA_REASON)
    if status in (401, 403):
        return PermanentModelProviderFailure(REJECTED_KEY_REASON)
    if status in (400, 404, 422):
        return PermanentModelProviderFailure(INVALID_REQUEST_REASON)
    return None


def is_model_provider_error(error: Exception) -> bool:
    """Return whether ``error`` came from calling the model provider."""
    return isinstance(error, httpx.HTTPStatusError | httpx.TransportError)
