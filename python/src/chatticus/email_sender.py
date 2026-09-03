"""Waitlist confirmation email delivery."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Protocol
from urllib.parse import urlencode


class EmailSender(Protocol):
    """Send waitlist confirmation emails."""

    def send_confirmation_email(self, email: str, confirmation_url: str) -> None:
        """Send one confirmation email with the signup link."""


class NoOpEmailSender:
    """Default sender that records intent without delivering mail."""

    def send_confirmation_email(self, email: str, confirmation_url: str) -> None:
        """Do nothing; delivery is exercised in production or acceptance runs."""


@dataclass
class RecordingEmailSender:
    """Capture confirmation emails for kernel and behavior specs."""

    sent: list[tuple[str, str]] = field(default_factory=list)

    def send_confirmation_email(self, email: str, confirmation_url: str) -> None:
        """Record one confirmation email."""
        self.sent.append((email, confirmation_url))


class SesEmailSender:
    """Send confirmation emails through Amazon SES."""

    def __init__(
        self,
        *,
        ses_client: Any | None = None,
        from_address: str | None = None,
        region: str | None = None,
    ) -> None:
        self._from_address = (
            from_address or os.environ.get("CHATTICUS_SES_FROM_ADDRESS", "").strip()
        )
        self._region = (
            region
            or os.environ.get("AWS_REGION")
            or os.environ.get("AWS_DEFAULT_REGION")
            or "us-east-1"
        )
        self._ses = ses_client

    def send_confirmation_email(self, email: str, confirmation_url: str) -> None:
        """Send one confirmation email via SES."""
        if not self._from_address:
            return
        ses = self._ses
        if ses is None:
            import boto3

            ses = boto3.client("ses", region_name=self._region)
        ses.send_email(
            Source=self._from_address,
            Destination={"ToAddresses": [email]},
            Message={
                "Subject": {"Data": "Confirm your Chatticus waitlist signup"},
                "Body": {
                    "Text": {
                        "Data": (
                            "Thanks for signing up for the Chatticus beta waitlist.\n\n"
                            f"Confirm your email: {confirmation_url}\n"
                        )
                    }
                },
            },
        )


def build_waitlist_confirmation_url(
    base_url: str,
    email: str,
    token: str,
) -> str:
    """Build the waitlist email confirmation URL for one signup."""
    query = urlencode({"email": email, "token": token})
    return f"{base_url.rstrip('/')}/waitlist/confirm?{query}"


def waitlist_confirmation_base_url_from_env() -> str:
    """Return the web origin used in waitlist confirmation links."""
    explicit = os.environ.get("CHATTICUS_WAITLIST_CONFIRMATION_BASE_URL", "").strip()
    if explicit:
        return explicit.rstrip("/")
    return "https://hey.chattic.us"


def email_sender_from_env() -> EmailSender:
    """Return the configured email sender, defaulting to a no-op."""
    kind = os.environ.get("CHATTICUS_EMAIL_SENDER", "").strip().lower()
    from_address = os.environ.get("CHATTICUS_SES_FROM_ADDRESS", "").strip()
    if kind == "ses" or from_address:
        return SesEmailSender(from_address=from_address or None)
    return NoOpEmailSender()
