"""Waitlist operator invitation tokens and URLs."""

from __future__ import annotations

from datetime import timedelta
from urllib.parse import urlencode

from chatticus.models import WaitlistSignup

WAITLIST_INVITATION_TTL_DAYS = 7


def waitlist_invitation_ttl() -> timedelta:
    """Return the invitation link lifetime."""
    return timedelta(days=WAITLIST_INVITATION_TTL_DAYS)


def build_waitlist_invitation_url(base_url: str, token: str) -> str:
    """Build the waitlist invitation URL for one signup."""
    query = urlencode({"token": token})
    return f"{base_url.rstrip('/')}/waitlist/invite?{query}"


def waitlist_signup_in_operator_queue(signup: WaitlistSignup) -> bool:
    """Return whether a signup belongs in the default operator queue."""
    return (
        signup.email_confirmed and not signup.disqualified and signup.invited_at is None
    )
