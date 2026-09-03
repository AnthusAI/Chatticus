"""Behave steps for the beta page waitlist survey form."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from behave import given, then, when
from waitlist_survey_steps import _sample_price_sensitivity_answers, _waitlist_payload

from chatticus.http.waitlist_source import FORWARDED_FOR_HEADER
from chatticus.waitlist_limits import WAITLIST_SUBMISSION_RATE_LIMIT

REPO_ROOT = Path(__file__).resolve().parents[2]
WEB_DIR = REPO_ROOT / "web"
MARKETING_HARNESS = WEB_DIR / "test-support" / "marketing-ui-harness.tsx"
SURVEY_HARNESS = WEB_DIR / "test-support" / "survey-form-harness.ts"
SURVEY_HARNESS_STATE = REPO_ROOT / ".survey-form-harness-state.json"


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


def _run_marketing_harness(command: str) -> dict:
    tsx = _tsx_binary()
    result = subprocess.run(
        [str(tsx), str(MARKETING_HARNESS), command],
        cwd=WEB_DIR,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"marketing UI harness failed ({command}): "
            f"{result.stderr or result.stdout}"
        )
    return json.loads(result.stdout)


def _run_survey_harness(command: str, payload: dict | None = None) -> dict:
    tsx = _tsx_binary()
    args = [str(tsx), str(SURVEY_HARNESS), command]
    if payload is not None:
        args.append(json.dumps(payload))
    env = {
        **dict(__import__("os").environ),
        "CHATTICUS_SURVEY_FORM_HARNESS_STATE": str(SURVEY_HARNESS_STATE),
    }
    result = subprocess.run(
        args,
        cwd=WEB_DIR,
        capture_output=True,
        text=True,
        check=False,
        env=env,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"survey form harness failed ({command}): "
            f"{result.stderr or result.stdout}"
        )
    return json.loads(result.stdout)


def _complete_survey_payload(email: str) -> dict[str, object]:
    return _waitlist_payload(
        email=email,
        fit_answers={"team_size": "12"},
        aws_readiness_answers={"has_aws_account": "yes"},
        setup_path_answers={"preferred_path": "self-setup"},
        price_answers={
            "professional_services_interest": "yes",
            "training_interest": "no",
        },
        price_sensitivity_answers=_sample_price_sensitivity_answers(),
        complete=True,
    )


@when("the page loads")
def when_page_loads(context: object) -> None:
    context.survey_form_harness = _run_survey_harness("reset")
    context.survey_form_harness = _run_survey_harness("load-survey")


@when("the survey form is rendered")
def when_the_survey_form_is_rendered(context: object) -> None:
    context.marketing_ui_harness = _run_marketing_harness("render-beta-survey")


@then("the work description question is a tall textarea")
def then_work_description_is_tall_textarea(context: object) -> None:
    html = context.marketing_ui_harness.get("html") or ""
    start = html.find("<textarea")
    assert start != -1, html
    chunk = html[start : start + 500]
    assert 'id="survey-fit-work_description"' in chunk, chunk
    assert 'rows="8"' in chunk, chunk
    assert "<input" not in chunk.split(">")[0]


@then("it fetches GET /waitlist/survey")
def then_fetches_waitlist_survey(context: object) -> None:
    harness = context.survey_form_harness
    assert harness.get("surveyFetched") is True, harness
    requests = harness.get("recordedRequests") or []
    survey_requests = [
        request
        for request in requests
        if str(request.get("url", "")).endswith("/waitlist/survey")
        and request.get("method") == "GET"
    ]
    assert survey_requests, harness


@then(
    "it renders an email field, a fit block, an AWS readiness block, "
    "a setup-path block, a price sensitivity block, a professional services "
    "interest question, and a training interest question"
)
def then_renders_all_survey_blocks(context: object) -> None:
    context.marketing_ui_harness = _run_marketing_harness("render-beta-survey")
    html = (context.marketing_ui_harness.get("html") or "").lower()
    assert 'id="survey-email"' in html, html
    assert 'id="survey-block-fit"' in html, html
    assert 'id="survey-block-aws_readiness"' in html, html
    assert 'id="survey-block-setup_path"' in html, html
    assert 'id="survey-block-price_sensitivity"' in html, html
    assert 'id="survey-block-professional_services_interest"' in html, html
    assert 'id="survey-block-training_interest"' in html, html


@given("a visitor who has filled in their work email and all survey blocks")
def given_visitor_filled_all_blocks(context: object) -> None:
    context.visitor_email = "complete@example.com"
    context.complete_survey_payload = _complete_survey_payload(context.visitor_email)
    context.survey_form_harness = _run_survey_harness("reset")


@when("they submit the survey")
def when_they_submit_survey(context: object) -> None:
    payload = context.complete_survey_payload
    if hasattr(context, "expected_utm"):
        context.survey_form_harness = _run_survey_harness(
            "submit-complete-with-utm",
            {
                **payload,
                "query": (
                    f"utm_source={context.expected_utm['utm_source']}"
                    f"&utm_campaign={context.expected_utm['utm_campaign']}"
                ),
            },
        )
        response = context.api_client.post(
            "/waitlist",
            json={
                **payload,
                **context.expected_utm,
            },
        )
        assert response.status_code == 201, response.text
        return

    context.survey_form_harness = _run_survey_harness(
        "submit-complete",
        payload,
    )


@then("it posts to POST /waitlist with complete: true")
def then_posts_complete_waitlist(context: object) -> None:
    harness = context.survey_form_harness
    payload = harness.get("lastSubmitPayload")
    assert payload is not None, harness
    assert payload.get("complete") is True, payload
    requests = harness.get("recordedRequests") or []
    post_requests = [
        request
        for request in requests
        if str(request.get("url", "")).endswith("/waitlist")
        and request.get("method") == "POST"
    ]
    assert post_requests, harness


@then("the page shows a thank-you confirmation")
def then_page_shows_thank_you(context: object) -> None:
    context.marketing_ui_harness = _run_marketing_harness(
        "render-beta-survey-thank-you"
    )
    text = (context.marketing_ui_harness.get("visibleText") or "").lower()
    assert "thank you" in text, text
    assert "waitlist" in text, text


@when("they blur their email without submitting")
def when_they_blur_email_without_submitting(context: object) -> None:
    context.survey_form_harness = _run_survey_harness("reset")
    context.survey_form_harness = _run_survey_harness(
        "submit-incomplete",
        {"email": context.visitor_email},
    )
    response = context.api_client.post(
        "/waitlist",
        json=_waitlist_payload(email=context.visitor_email, complete=False),
    )
    assert response.status_code == 201, response.text


@then("it posts to POST /waitlist with complete: false on email blur")
def then_posts_incomplete_on_email_blur(context: object) -> None:
    harness = context.survey_form_harness
    payload = harness.get("lastSubmitPayload")
    assert payload is not None, harness
    assert payload.get("complete") is False, payload
    assert payload.get("email") == context.visitor_email, payload


@then("a waitlist signup is recorded for that email marked incomplete")
def then_signup_recorded_incomplete(context: object) -> None:
    signup = context.plane._messaging_store.get_waitlist_signup(context.visitor_email)
    assert signup is not None
    assert signup.complete is False
    context.last_signup = signup


@given("a source that has submitted at the allowed limit")
def given_source_at_allowed_limit(context: object) -> None:
    context.waitlist_source_ip = "203.0.113.77"
    for index in range(WAITLIST_SUBMISSION_RATE_LIMIT):
        response = context.api_client.post(
            "/waitlist",
            headers={FORWARDED_FOR_HEADER: context.waitlist_source_ip},
            json={
                "email": f"limit-{index}@example.com",
                "complete": True,
            },
        )
        assert response.status_code == 201, response.text
    context.survey_form_harness = _run_survey_harness("reset")
    context.survey_form_harness = _run_survey_harness(
        "set-submit-status",
        {"status": 429},
    )


@when("they submit again from the survey form")
def when_they_submit_again_from_form(context: object) -> None:
    payload = _complete_survey_payload("overflow@example.com")
    context.survey_form_harness = _run_survey_harness("submit-complete", payload)


@then("the page shows a rate-limit message")
def then_page_shows_rate_limit_message(context: object) -> None:
    context.marketing_ui_harness = _run_marketing_harness(
        "render-beta-survey-rate-limited"
    )
    text = (context.marketing_ui_harness.get("visibleText") or "").lower()
    assert "too many submissions" in text, text
