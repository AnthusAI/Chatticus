"""Behave steps for the waitlist operator CLI."""

from __future__ import annotations

import csv
import io
from datetime import UTC, datetime, timedelta

from behave import given, then, when
from organization_steps import _plane
from waitlist_survey_steps import _sample_price_sensitivity_answers
from waitlist_triage_steps import given_confirmed_signups_on_aws_and_other_clouds

from chatticus.models import PriceSensitivityAnswers
from chatticus.offer_snapshot import current_offer_snapshot
from chatticus.waitlist.__main__ import main as waitlist_main
from chatticus.waitlist_scoring import SERVICES_QUALIFIED_MINIMUM_SCORE

__all__ = ["given_confirmed_signups_on_aws_and_other_clouds"]


def _record_and_confirm_signup(
    context: object,
    *,
    email: str,
    fit_answers: dict[str, str],
    aws_readiness_answers: dict[str, str],
    price_answers: dict[str, str],
    price_sensitivity_answers: PriceSensitivityAnswers | None = None,
    created_at: datetime | None = None,
) -> None:
    plane = _plane(context)
    plane.record_waitlist_signup(
        email=email,
        fit_answers=fit_answers,
        aws_readiness_answers=aws_readiness_answers,
        price_answers=price_answers,
        setup_path_answers={"installation_preference": "self-install"},
        price_sensitivity_answers=price_sensitivity_answers,
        complete=True,
        source="behave-test",
    )
    if created_at is not None:
        signup = plane._messaging_store.get_waitlist_signup(email)
        assert signup is not None
        from dataclasses import replace

        plane._messaging_store.put_waitlist_signup(
            replace(signup, created_at=created_at)
        )
    plane.confirm_waitlist_email(email)


@given("confirmed waitlist signups with a range of scores")
def given_confirmed_waitlist_signups_with_score_range(context: object) -> None:
    base_time = datetime(2026, 9, 1, 12, 0, 0, tzinfo=UTC)
    _record_and_confirm_signup(
        context,
        email="high-score@example.com",
        fit_answers={
            "organization_size": "101-plus",
            "seniority": "founder-executive-or-lead",
            "urgency": "this-week",
        },
        aws_readiness_answers={
            "cloud_provider": "aws",
            "account_status": "production-workloads",
            "aws_spend": "10k-plus",
            "cloud_authority": "me",
            "byok_readiness": "already-in-production",
        },
        price_answers={"professional_services_interest": "yes-with-budget"},
        created_at=base_time,
    )
    _record_and_confirm_signup(
        context,
        email="mid-score@example.com",
        fit_answers={
            "organization_size": "26-to-100",
            "seniority": "manager",
            "urgency": "this-month",
        },
        aws_readiness_answers={
            "cloud_provider": "aws",
            "account_status": "production-workloads",
            "cloud_authority": "devops-team",
        },
        price_answers={"professional_services_interest": "tell-me-more"},
        created_at=base_time + timedelta(minutes=1),
    )
    _record_and_confirm_signup(
        context,
        email="low-score@example.com",
        fit_answers={"organization_size": "1-to-5"},
        aws_readiness_answers={
            "cloud_provider": "aws",
            "account_status": "exploring-no-production",
        },
        price_answers={"professional_services_interest": "not-now"},
        created_at=base_time + timedelta(minutes=2),
    )
    disqualified_email = "gcp-queue@example.com"
    _record_and_confirm_signup(
        context,
        email=disqualified_email,
        fit_answers={},
        aws_readiness_answers={"cloud_provider": "gcp"},
        price_answers={},
        created_at=base_time + timedelta(minutes=3),
    )
    context.waitlist_cli_disqualified_email = disqualified_email
    context.waitlist_cli_score_range_emails = (
        "high-score@example.com",
        "mid-score@example.com",
        "low-score@example.com",
    )


@given("confirmed waitlist signups")
def given_confirmed_waitlist_signups(context: object) -> None:
    plane = _plane(context)
    offer = current_offer_snapshot(plane._now)
    plane.record_waitlist_signup(
        email="export@example.com",
        fit_answers={
            "organization_size": "26-to-100",
            "seniority": "manager",
            "urgency": "this-quarter",
            "work_description": (
                "We need help automating customer onboarding workflows."
            ),
        },
        aws_readiness_answers={
            "cloud_provider": "aws",
            "account_status": "production-workloads",
            "aws_spend": "1k-to-10k",
            "cloud_authority": "me",
            "byok_readiness": "have-keys-not-in-production",
            "security_review_cycle": "unsure",
        },
        price_answers={
            "professional_services_interest": "tell-me-more",
            "training_interest": "yes-with-budget",
        },
        setup_path_answers={"installation_preference": "turn-key"},
        price_sensitivity_answers=_sample_price_sensitivity_answers(),
        complete=True,
        source="behave-test",
        offer_snapshot=offer,
    )
    plane.confirm_waitlist_email("export@example.com")
    context.waitlist_cli_export_email = "export@example.com"
    context.waitlist_cli_export_offer = offer
    context.waitlist_cli_export_price_sensitivity = _sample_price_sensitivity_answers()


@when("the waitlist CLI lists the queue")
def when_waitlist_cli_lists_queue(context: object) -> None:
    _run_waitlist_cli(context, ["list"])


@when("the waitlist CLI lists the queue filtered to services-qualified")
def when_waitlist_cli_lists_services_qualified(context: object) -> None:
    _run_waitlist_cli(context, ["list", "--services-qualified"])


@when("the waitlist CLI lists disqualified signups")
def when_waitlist_cli_lists_disqualified(context: object) -> None:
    _run_waitlist_cli(context, ["list", "--disqualified"])


@when("the waitlist CLI exports the waitlist as CSV")
def when_waitlist_cli_exports_csv(context: object) -> None:
    _run_waitlist_cli(context, ["export"])


@then("the waitlist CLI output is ordered by score descending")
def then_waitlist_cli_output_score_descending(context: object) -> None:
    scores = _parse_list_scores(context.waitlist_cli_output)
    assert scores == sorted(scores, reverse=True)
    assert context.waitlist_cli_exit == 0


@then("no disqualified signup appears in the waitlist CLI output")
def then_no_disqualified_in_waitlist_cli_output(context: object) -> None:
    output = context.waitlist_cli_output
    disqualified_email = context.waitlist_cli_disqualified_email
    plane = _plane(context)
    signup = plane._messaging_store.get_waitlist_signup(disqualified_email)
    assert signup is not None
    assert signup.disqualified is True
    assert disqualified_email not in output


@then("every signup in the waitlist CLI output scored at least 10")
def then_every_waitlist_cli_signup_scored_at_least_ten(context: object) -> None:
    scores = _parse_list_scores(context.waitlist_cli_output)
    assert scores
    assert all(score >= SERVICES_QUALIFIED_MINIMUM_SCORE for score in scores)
    assert context.waitlist_cli_exit == 0


@then("each CSV row carries the survey answers, the score, and the price block")
def then_csv_rows_carry_survey_score_and_price_block(context: object) -> None:
    rows = list(csv.DictReader(io.StringIO(context.waitlist_cli_output)))
    assert rows
    email = context.waitlist_cli_export_email
    row = next(item for item in rows if item["email"] == email)
    assert row["fit_organization_size"] == "26-to-100"
    assert row["aws_cloud_provider"] == "aws"
    assert row["price_professional_services_interest"] == "tell-me-more"
    assert row["price_training_interest"] == "yes-with-budget"
    assert int(row["waitlist_score"]) >= 0
    price_sensitivity = context.waitlist_cli_export_price_sensitivity
    assert row["price_sensitivity_too_cheap"] == price_sensitivity.too_cheap
    assert row["price_sensitivity_bargain"] == price_sensitivity.bargain
    assert row["price_sensitivity_expensive"] == price_sensitivity.expensive
    assert row["price_sensitivity_too_expensive"] == price_sensitivity.too_expensive
    offer = context.waitlist_cli_export_offer
    assert row["offer_content_hash"] == offer.content_hash
    assert row["offer_content_version"] == offer.content_version
    assert context.waitlist_cli_exit == 0


@then("every signup in the waitlist CLI output is disqualified")
def then_every_waitlist_cli_signup_disqualified(context: object) -> None:
    emails = _parse_list_emails(context.waitlist_cli_output)
    assert emails
    plane = _plane(context)
    for email in emails:
        signup = plane._messaging_store.get_waitlist_signup(email)
        assert signup is not None
        assert signup.disqualified is True
    assert context.waitlist_cli_exit == 0


@then("no queued signup appears in the waitlist CLI output")
def then_no_queued_signup_in_waitlist_cli_output(context: object) -> None:
    emails = set(_parse_list_emails(context.waitlist_cli_output))
    plane = _plane(context)
    for signup in plane.list_waitlist_queue():
        assert signup.email not in emails


def _run_waitlist_cli(context: object, argv: list[str]) -> None:
    buffer = io.StringIO()
    plane = _plane(context)
    with _capture_stdout(buffer):
        context.waitlist_cli_exit = waitlist_main(
            argv,
            plane_factory=lambda: plane,
        )
    context.waitlist_cli_output = buffer.getvalue()


def _parse_list_lines(output: str) -> list[list[str]]:
    lines = [line for line in output.strip().splitlines() if line.strip()]
    return [line.split("\t") for line in lines]


def _parse_list_scores(output: str) -> list[int]:
    scores: list[int] = []
    for parts in _parse_list_lines(output):
        score_text = parts[1]
        scores.append(int(score_text))
    return scores


def _parse_list_emails(output: str) -> list[str]:
    return [parts[0] for parts in _parse_list_lines(output)]


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
