"""Behave steps for beta pitch cost disclosure."""

from __future__ import annotations

from behave import then

COST_MARKERS = (
    "$20 a month",
    "aws infrastructure is billed to the customer",
    "model tokens",
    "anthropic or openai",
    "$0",
    "$100",
)


@then("it states the monthly Chatticus fee")
def then_states_monthly_fee(context: object) -> None:
    text = (context.marketing_ui_harness.get("visibleText") or "").lower()
    assert (
        "$20 a month" in text or "$20 / month" in text or "$20 per month" in text
    ), text


@then("it states that AWS infrastructure is billed to the customer")
def then_states_aws_billed(context: object) -> None:
    text = (context.marketing_ui_harness.get("visibleText") or "").lower()
    assert (
        "aws infrastructure is billed to the customer" in text
        or "aws bill" in text
        or "billed directly by aws" in text
        or "aws is billed to the customer" in text
    ), text


@then("it states that model tokens are billed to the customer")
def then_states_model_tokens_billed(context: object) -> None:
    text = (context.marketing_ui_harness.get("visibleText") or "").lower()
    assert (
        "model tokens" in text or "token cost" in text or "anthropic or openai" in text
    ), text


@then("it states the setup fee for each setup path")
def then_states_setup_fee(context: object) -> None:
    text = (context.marketing_ui_harness.get("visibleText") or "").lower()
    assert "$0" in text and "$100" in text, text


@then("all of them appear above the first survey question")
def then_appear_above_first_survey_question(context: object) -> None:
    html = (context.marketing_ui_harness.get("html") or "").lower()
    survey_index = html.find('id="survey-fit"')
    assert survey_index != -1, html
    for marker in COST_MARKERS:
        marker_index = html.find(marker)
        assert marker_index != -1, marker
        assert (
            marker_index < survey_index
        ), f"{marker!r} appears after the first survey question"


@then("no price on the page ends in .95")
def then_no_price_ends_in_95(context: object) -> None:
    text = (context.marketing_ui_harness.get("visibleText") or "").lower()
    assert ".95" not in text, text


@then("it states that features change without notice")
def then_states_features_change(context: object) -> None:
    text = (context.marketing_ui_harness.get("visibleText") or "").lower()
    assert (
        "features change without notice" in text or "change without notice" in text
    ), text


@then("it states that there is no uptime guarantee")
def then_states_no_uptime_guarantee(context: object) -> None:
    text = (context.marketing_ui_harness.get("visibleText") or "").lower()
    assert "no uptime guarantee" in text, text


@then("it states that the subscription can be cancelled at any time")
def then_states_subscription_cancelled(context: object) -> None:
    text = (context.marketing_ui_harness.get("visibleText") or "").lower()
    assert "cancelled at any time" in text or "cancel at any time" in text, text


@then("it states that the deployment stays in the customer account if they leave")
def then_states_deployment_stays(context: object) -> None:
    text = (context.marketing_ui_harness.get("visibleText") or "").lower()
    assert (
        "stays in the customer account" in text or "stays in your account" in text
    ), text
