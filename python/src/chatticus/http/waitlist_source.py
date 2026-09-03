"""Client identity for waitlist flood limiting."""

from __future__ import annotations

from fastapi import Request

FORWARDED_FOR_HEADER = "X-Forwarded-For"


def waitlist_submission_source(request: Request) -> str:
    """Return the client identity used for waitlist flood limiting."""
    forwarded = request.headers.get(FORWARDED_FOR_HEADER)
    if forwarded:
        return forwarded.split(",")[0].strip()
    if request.client is not None:
        return request.client.host
    return "unknown"
