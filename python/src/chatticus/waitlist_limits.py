"""Limits for unauthenticated waitlist survey submissions."""

from __future__ import annotations

from datetime import timedelta

WAITLIST_SUBMISSION_RATE_LIMIT = 5
WAITLIST_SUBMISSION_RATE_WINDOW = timedelta(hours=1)
