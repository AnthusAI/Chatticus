"""Behave steps for beta waitlist UTM capture and conversion events."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from behave import given, then, when
from beta_waitlist_survey_form_steps import (
    _complete_survey_payload,
    _run_survey_harness,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
WEB_DIR = REPO_ROOT / "web"
ANALYTICS_HARNESS = WEB_DIR / "test-support" / "analytics-harness.ts"


def _tsx_binary() -> Path:
    candidates = (
        WEB_DIR / "node_modules" / ".bin" / "tsx",
        REPO_ROOT / "node_modules" / ".bin" / "tsx",
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(
        "tsx not found; run npm install at the repo root "
        f"(checked {candidates[0]} and {candidates[1]})"
    )


def _run_analytics_harness(command: str, payload: dict | None = None) -> dict:
    tsx = _tsx_binary()
    args = [str(tsx), str(ANALYTICS_HARNESS), command]
    if payload is not None:
        args.append(json.dumps(payload))
    result = subprocess.run(
        args,
        cwd=WEB_DIR,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"analytics harness failed ({command}): "
            f"{result.stderr or result.stdout}"
        )
    return json.loads(result.stdout)


@given("a visitor arrives at /beta with utm_source=google and utm_campaign=beta_launch")
def given_visitor_arrives_with_utm_params(context: object) -> None:
    context.visitor_email = "utm@example.com"
    context.expected_utm = {
        "utm_source": "google",
        "utm_campaign": "beta_launch",
    }
    context.complete_survey_payload = _complete_survey_payload(context.visitor_email)
    context.survey_form_harness = _run_survey_harness("reset")
    context.analytics_harness = _run_analytics_harness(
        "capture-utm",
        {"query": "utm_source=google&utm_campaign=beta_launch"},
    )


@then("the waitlist signup records the UTM source, medium, campaign, content, and term")
def then_waitlist_signup_records_utm_fields(context: object) -> None:
    harness = context.survey_form_harness
    payload = harness.get("lastSubmitPayload")
    assert payload is not None, harness
    assert payload.get("utm_source") == context.expected_utm["utm_source"], payload
    assert payload.get("utm_campaign") == context.expected_utm["utm_campaign"], payload

    signup = context.plane._messaging_store.get_waitlist_signup(context.visitor_email)
    assert signup is not None
    assert signup.utm_source == context.expected_utm["utm_source"]
    assert signup.utm_campaign == context.expected_utm["utm_campaign"]
    assert signup.utm_medium is None
    assert signup.utm_content is None
    assert signup.utm_term is None


@when("the visitor loads the beta page")
def when_visitor_loads_beta_page(context: object) -> None:
    context.analytics_harness = _run_analytics_harness("load-beta-page")


@then("a page_view event is fired")
def then_page_view_event_is_fired(context: object) -> None:
    harness = context.analytics_harness
    events = harness.get("events") or []
    page_views = [event for event in events if event.get("event") == "page_view"]
    assert page_views, harness


@given("a visitor who completes the survey")
def given_visitor_who_completes_survey(context: object) -> None:
    context.visitor_email = "conversion@example.com"
    context.complete_survey_payload = _complete_survey_payload(context.visitor_email)
    context.survey_form_harness = _run_survey_harness("reset")
    context.analytics_harness = _run_analytics_harness("reset")


@when("they submit it")
def when_they_submit_completed_survey(context: object) -> None:
    context.survey_form_harness = _run_survey_harness(
        "submit-complete",
        context.complete_survey_payload,
    )


@then("a signup_complete conversion event is fired")
def then_signup_complete_event_is_fired(context: object) -> None:
    harness = context.survey_form_harness
    events = harness.get("analyticsEvents") or []
    conversions = [event for event in events if event.get("event") == "signup_complete"]
    assert conversions, harness
