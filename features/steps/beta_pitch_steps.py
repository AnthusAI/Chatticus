"""Behave steps for beta pitch cost disclosure and pricing matrix."""

from __future__ import annotations

from behave import given, then
from marketing_positioning_steps import _run_harness

COST_MARKERS = (
    "$20 a month",
    "aws infrastructure is billed to the customer",
    "model tokens",
    "anthropic or openai",
    "$0",
    "$100",
)


@given("a visitor on the beta pitch page")
def given_visitor_on_beta_pitch_page(context: object) -> None:
    context.marketing_ui_harness = _run_harness("render-beta")


def _visible_text(context: object) -> str:
    return (context.marketing_ui_harness.get("visibleText") or "").lower()


@then(
    "the page shows a management dimension with two options: "
    "managed at $20/month or self-hosted at $0/month"
)
def then_page_shows_management_dimension(context: object) -> None:
    text = _visible_text(context)
    assert "management" in text, text
    assert "managed service" in text or "managed" in text, text
    assert "self-hosted" in text, text
    assert "$20/month" in text or "$20 a month" in text, text
    assert "$0/month" in text or "$0" in text, text


@then(
    "the page shows an installation dimension with two options: "
    "turn-key at $100 once or self-install at $0"
)
def then_page_shows_installation_dimension(context: object) -> None:
    text = _visible_text(context)
    assert "installation" in text, text
    assert "turn-key" in text or "turn-key install" in text, text
    assert "self-install" in text, text
    assert "$100 once" in text or "$100" in text, text
    assert "$0" in text, text


@then("both the management fee and the installation fee are shown as optional")
def then_both_fees_shown_as_optional(context: object) -> None:
    text = _visible_text(context)
    assert "optional" in text, text
    assert text.count("optional") >= 2, text


@then(
    "the page states that managed service means Anthus runs the "
    "control plane infrastructure"
)
def then_managed_service_means_anthus_runs_control_plane(context: object) -> None:
    text = _visible_text(context)
    assert "anthus runs the core chatticus management infrastructure" in text, text


@then(
    "the page states that the customer's AWS account, file system, "
    "and encrypted secrets stay in the customer's account"
)
def then_customer_resources_stay_in_customer_account(context: object) -> None:
    text = _visible_text(context)
    assert "your aws account, file system, and encrypted secrets stay in" in text, text
    assert "your account" in text, text


@then(
    "the page states that managed service covers availability, continuous "
    "upgrades, security scanning, privacy safeguards, and ITSM"
)
def then_managed_service_covers_itsm(context: object) -> None:
    text = _visible_text(context)
    assert "availability" in text, text
    assert "continuous upgrades" in text, text
    assert "security scanning" in text, text
    assert "privacy safeguards" in text, text
    assert "itsm" in text, text


@then(
    "the page states that self-hosted means the customer runs the control "
    "plane themselves in their own AWS account"
)
def then_self_hosted_means_customer_runs_control_plane(context: object) -> None:
    text = _visible_text(context)
    assert "you run the chatticus control plane yourself" in text, text
    assert "your own aws account" in text, text


@then("the page states that there is no monthly management fee to Anthus")
def then_no_monthly_management_fee_to_anthus(context: object) -> None:
    text = _visible_text(context)
    assert "no monthly management fee to anthus" in text, text


@then("the page shows a blurb for optional professional services")
def then_page_shows_professional_services_blurb(context: object) -> None:
    text = _visible_text(context)
    assert "professional services" in text, text
    assert "optional" in text, text
    assert "anthus ai solutions" in text, text


@then(
    "the blurb states that Anthus AI Solutions adapts Chatticus "
    "to the customer's needs"
)
def then_professional_services_adapts_chatticus(context: object) -> None:
    text = _visible_text(context)
    assert "we adapt chatticus to your needs" in text, text


@then("the page shows a blurb for optional professional training")
def then_page_shows_professional_training_blurb(context: object) -> None:
    text = _visible_text(context)
    assert "professional training" in text, text
    assert "optional" in text, text
    assert "anthus ai solutions" in text, text


@then("the blurb states that training is available from Anthus AI Solutions")
def then_training_available_from_anthus(context: object) -> None:
    text = _visible_text(context)
    assert "professional training from anthus ai solutions" in text, text


@then("the page states that the customer brings their own AWS account")
def then_customer_brings_own_aws_account(context: object) -> None:
    text = _visible_text(context)
    assert "you bring your own aws account" in text, text


@then("the page states that the customer may bring their own AI API accounts")
def then_customer_may_bring_own_ai_api_accounts(context: object) -> None:
    text = _visible_text(context)
    assert "may bring your own ai api accounts" in text, text


@then(
    "the page lists OpenAI, Anthropic, xAI, DeepSeek, Moonshot, "
    "and Amazon Bedrock as options"
)
def then_page_lists_ai_api_providers(context: object) -> None:
    text = _visible_text(context)
    for provider in (
        "openai",
        "anthropic",
        "xai",
        "deepseek",
        "moonshot",
        "amazon bedrock",
    ):
        assert provider in text, f"missing provider: {provider}"


@then("it states the monthly Chatticus fee")
def then_states_monthly_fee(context: object) -> None:
    text = _visible_text(context)
    assert (
        "$20 a month" in text or "$20 / month" in text or "$20 per month" in text
    ), text


@then("it states that AWS infrastructure is billed to the customer")
def then_states_aws_billed(context: object) -> None:
    text = _visible_text(context)
    assert (
        "aws infrastructure is billed to the customer" in text
        or "aws bill" in text
        or "billed directly by aws" in text
        or "aws is billed to the customer" in text
    ), text


@then("it states that model tokens are billed to the customer")
def then_states_model_tokens_billed(context: object) -> None:
    text = _visible_text(context)
    assert (
        "model tokens" in text or "token cost" in text or "anthropic or openai" in text
    ), text


@then("it states the setup fee for each setup path")
def then_states_setup_fee(context: object) -> None:
    text = _visible_text(context)
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
    text = _visible_text(context)
    assert ".95" not in text, text


@then("it states that features change without notice")
def then_states_features_change(context: object) -> None:
    text = _visible_text(context)
    assert (
        "features change without notice" in text or "change without notice" in text
    ), text


@then("it states that there is no uptime guarantee")
def then_states_no_uptime_guarantee(context: object) -> None:
    text = _visible_text(context)
    assert "no uptime guarantee" in text, text


@then("it states that the subscription can be cancelled at any time")
def then_states_subscription_cancelled(context: object) -> None:
    text = _visible_text(context)
    assert "cancelled at any time" in text or "cancel at any time" in text, text


@then("it states that the deployment stays in the customer account if they leave")
def then_states_deployment_stays(context: object) -> None:
    text = _visible_text(context)
    assert (
        "stays in the customer account" in text or "stays in your account" in text
    ), text
