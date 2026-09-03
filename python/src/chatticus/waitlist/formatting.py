"""TSV formatting and score ordering for the waitlist operator CLI."""

from __future__ import annotations

from chatticus.models import WaitlistSignup


def sort_waitlist_by_score_desc(signups: list[WaitlistSignup]) -> list[WaitlistSignup]:
    """Return signups by score descending, then created_at ascending."""
    return sorted(
        signups,
        key=lambda signup: (
            -(signup.waitlist_score if signup.waitlist_score is not None else -1),
            signup.created_at,
        ),
    )


def format_waitlist_list_line(signup: WaitlistSignup) -> str:
    """Format one waitlist signup as a tab-separated list row."""
    cloud_provider = signup.aws_readiness_answers.get("cloud_provider", "")
    organization_size = signup.fit_answers.get("organization_size", "")
    score_text = str(signup.waitlist_score) if signup.waitlist_score is not None else ""
    services_qualified = "true" if signup.services_qualified else "false"
    return (
        f"{signup.email}\t{score_text}\t{services_qualified}\t"
        f"{cloud_provider}\t{organization_size}"
    )


def print_waitlist_list(signups: list[WaitlistSignup]) -> None:
    """Print waitlist signups as tab-separated lines to stdout."""
    for signup in signups:
        print(format_waitlist_list_line(signup))
