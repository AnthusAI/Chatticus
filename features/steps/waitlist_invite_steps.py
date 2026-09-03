"""Behave steps for waitlist operator invitations."""

from __future__ import annotations

import io
from dataclasses import replace
from datetime import timedelta

from behave import given, then, when
from organization_steps import _plane
from waitlist_cli_steps import _run_waitlist_cli
from waitlist_triage_steps import (
    _ensure_triage_signup_recorded,
    _reset_triage_signup_context,
)

from chatticus.waitlist.__main__ import main as waitlist_main
from chatticus.waitlist.invitation import build_waitlist_invitation_url


def _signup(context: object):
    signup = _plane(context)._messaging_store.get_waitlist_signup(context.signup_email)
    assert signup is not None
    return signup


def _record_queued_signup(
    context: object, *, email: str = "invite@example.com"
) -> None:
    plane = _plane(context)
    plane.record_waitlist_signup(
        email=email,
        fit_answers={
            "organization_size": "26-to-100",
            "seniority": "manager",
            "urgency": "this-month",
        },
        aws_readiness_answers={
            "cloud_provider": "aws",
            "account_status": "production-workloads",
        },
        price_answers={"professional_services_interest": "tell-me-more"},
        setup_path_answers={"installation_preference": "self-install"},
        price_sensitivity_answers=None,
        complete=True,
        source="behave-test",
    )
    plane.confirm_waitlist_email(email)
    context.signup_email = email


@given("a confirmed waitlist signup in the queue")
def given_confirmed_waitlist_signup_in_queue(context: object) -> None:
    _record_queued_signup(context)


@given("a disqualified confirmed waitlist signup")
def given_disqualified_confirmed_waitlist_signup(context: object) -> None:
    email = "disqualified-invite@example.com"
    plane = _plane(context)
    plane.record_waitlist_signup(
        email=email,
        fit_answers={},
        aws_readiness_answers={"cloud_provider": "gcp"},
        price_answers={},
        setup_path_answers={},
        price_sensitivity_answers=None,
        complete=True,
        source="behave-test",
    )
    plane.confirm_waitlist_email(email)
    context.signup_email = email


@given("a complete waitlist signup with email not yet confirmed")
def given_unconfirmed_waitlist_signup(context: object) -> None:
    email = "unconfirmed-invite@example.com"
    _reset_triage_signup_context(context, email)
    _ensure_triage_signup_recorded(context)
    context.signup_email = email


@given("an invited waitlist signup")
def given_invited_waitlist_signup(context: object) -> None:
    _record_queued_signup(context)
    _invite_signup(context)


@given("an invited waitlist signup with a non-expired link")
def given_invited_waitlist_signup_non_expired(context: object) -> None:
    given_invited_waitlist_signup(context)


@given("an invited waitlist signup whose link has been followed")
def given_invited_waitlist_signup_consumed(context: object) -> None:
    given_invited_waitlist_signup(context)
    token = context.invitation_token
    response = context.api_client.get("/waitlist/invite", params={"token": token})
    context.waitlist_invite_response = response
    signup = _signup(context)
    assert signup.invitation_consumed_at is not None


@given("an invited waitlist signup whose link has expired")
def given_invited_waitlist_signup_expired(context: object) -> None:
    _record_queued_signup(context, email="expired-invite@example.com")
    plane = _plane(context)
    now = plane._now
    expired_at = now - timedelta(days=1)
    signup = _signup(context)
    plane._messaging_store.put_waitlist_signup(
        replace(
            signup,
            invited_at=expired_at - timedelta(days=7),
            invitation_token="expired-invite-token",
            invitation_expires_at=expired_at,
        )
    )
    plane._messaging_store.put_waitlist_invite_pointer(
        "expired-invite-token",
        context.signup_email,
    )
    context.invitation_token = "expired-invite-token"


@when("an operator invites them via the waitlist CLI")
def when_operator_invites_via_cli(context: object) -> None:
    _run_waitlist_cli(context, ["invite", context.signup_email])
    signup = _signup(context)
    context.invitation_token = signup.invitation_token
    assert context.invitation_token is not None


@when("an operator tries to invite them via the waitlist CLI")
def when_operator_tries_to_invite_via_cli(context: object) -> None:
    buffer = io.StringIO()
    plane = _plane(context)
    with _capture_stderr(buffer):
        context.waitlist_cli_exit = waitlist_main(
            ["invite", context.signup_email],
            plane_factory=lambda: plane,
        )
    context.waitlist_cli_error = buffer.getvalue()


@when("a GET request to /waitlist/invite with a valid token")
def when_get_waitlist_invite_with_valid_token(context: object) -> None:
    token = context.invitation_token
    assert token is not None
    context.waitlist_invite_response = context.api_client.get(
        "/waitlist/invite",
        params={"token": token},
    )


@when("a GET request to /waitlist/invite with the same token")
def when_get_waitlist_invite_with_same_token(context: object) -> None:
    when_get_waitlist_invite_with_valid_token(context)


@when("a GET request to /waitlist/invite with that token")
def when_get_waitlist_invite_with_that_token(context: object) -> None:
    when_get_waitlist_invite_with_valid_token(context)


@then("an invitation link is issued for that signup")
def then_invitation_link_issued(context: object) -> None:
    signup = _signup(context)
    assert signup.invitation_token is not None
    assert signup.invitation_expires_at is not None
    assert context.waitlist_cli_exit == 0
    expected = build_waitlist_invitation_url(
        "https://hey.chattic.us",
        signup.invitation_token,
    )
    assert expected in context.waitlist_cli_output


@then("the signup is marked invited")
def then_signup_is_marked_invited(context: object) -> None:
    signup = _signup(context)
    assert signup.invited_at is not None


@then("the invitation email is sent")
def then_invitation_email_is_sent(context: object) -> None:
    signup = _signup(context)
    sent = [
        url
        for recipient, url in context.email_sender.invitations_sent
        if recipient == signup.email
    ]
    assert sent
    assert signup.invitation_token is not None
    assert signup.invitation_token in sent[-1]


@then("that signup does not appear in the waitlist CLI output")
def then_signup_not_in_waitlist_cli_output(context: object) -> None:
    assert context.signup_email not in context.waitlist_cli_output
    assert context.waitlist_cli_exit == 0


@then("the waitlist CLI refuses with a not-invitable error")
def then_waitlist_cli_refuses_not_invitable(context: object) -> None:
    assert context.waitlist_cli_exit == 1
    assert "not invitable" in context.waitlist_cli_error.lower()


@then("the invitation is marked consumed")
def then_invitation_is_marked_consumed(context: object) -> None:
    signup = _signup(context)
    assert signup.invitation_consumed_at is not None


@then("the response offers sign-in at /chat")
def then_response_offers_sign_in(context: object) -> None:
    response = context.waitlist_invite_response
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "accepted"
    assert payload["sign_in_url"] == "/chat"


@then("the invitation is refused")
def then_invitation_is_refused(context: object) -> None:
    response = context.waitlist_invite_response
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] in {"invalid_token", "expired", "already_used"}


def _invite_signup(context: object) -> None:
    buffer = io.StringIO()
    plane = _plane(context)
    with _capture_stdout(buffer):
        exit_code = waitlist_main(
            ["invite", context.signup_email],
            plane_factory=lambda: plane,
        )
    assert exit_code == 0
    context.waitlist_cli_output = buffer.getvalue()
    context.waitlist_cli_exit = exit_code
    signup = _signup(context)
    context.invitation_token = signup.invitation_token


class _capture_stdout:
    def __init__(self, buffer: io.StringIO) -> None:
        self.buffer = buffer

    def __enter__(self) -> io.StringIO:
        import sys

        self._stdout = sys.stdout
        sys.stdout = self.buffer
        return self.buffer

    def __exit__(self, *args: object) -> None:
        import sys

        sys.stdout = self._stdout


class _capture_stderr:
    def __init__(self, buffer: io.StringIO) -> None:
        self.buffer = buffer

    def __enter__(self) -> io.StringIO:
        import sys

        self._stderr = sys.stderr
        sys.stderr = self.buffer
        return self.buffer

    def __exit__(self, *args: object) -> None:
        import sys

        sys.stderr = self._stderr
