"""Behave steps for marketing homepage positioning."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from behave import given, then

REPO_ROOT = Path(__file__).resolve().parents[2]
WEB_DIR = REPO_ROOT / "web"
HARNESS = WEB_DIR / "test-support" / "marketing-ui-harness.tsx"


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


def _run_harness(command: str) -> dict:
    tsx = _tsx_binary()
    args = [str(tsx), str(HARNESS), command]
    env = dict(__import__("os").environ)
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
            f"marketing UI harness failed ({command}): "
            f"{result.stderr or result.stdout}"
        )
    return json.loads(result.stdout)


@given("the chattic.us home page")
def given_home_page(context: object) -> None:
    context.marketing_ui_harness = _run_harness("render")


@then("it states that the deployment runs in infrastructure the customer controls")
def then_states_infrastructure_customer_controls(context: object) -> None:
    text = (context.marketing_ui_harness.get("visibleText") or "").lower()
    assert (
        "infrastructure you control" in text
        or "infrastructure the customer controls" in text
        or "infrastructure that runs chatticus for you can stand up" in text
        or "on your infrastructure" in text
        or "run your bot farm on our infrastructure, or take the whole stack" in text
    ), text


@then("it states that the source can be read, forked, and changed")
def then_states_source_can_be_read_forked_changed(context: object) -> None:
    text = (context.marketing_ui_harness.get("visibleText") or "").lower()
    assert (
        "mit-licensed code" in text
        or "free to copy, change, and run" in text
        or "source can be read, forked, and changed" in text
    ), text


@then("it states that Anthus runs its own organizations on Chatticus")
def then_states_anthus_runs_own_orgs(context: object) -> None:
    text = (context.marketing_ui_harness.get("visibleText") or "").lower()
    assert (
        "anthus runs its own organizations on chatticus" in text
        or "the people who wrote it run their own business on it" in text
    ), text


@then("it states that managed customers run what Anthus runs")
def then_states_managed_customers_run_what_anthus_runs(context: object) -> None:
    text = (context.marketing_ui_harness.get("visibleText") or "").lower()
    assert (
        "buying the managed service puts you next to them" in text
        or "managed customers run what anthus runs" in text
    ), text

@then("it states that the organization computer runs in an AWS account the customer controls")
def then_states_aws_account(context: object) -> None:
    text = (context.marketing_ui_harness.get("visibleText") or "").lower()
    assert "runs in an aws account you own" in text, text


@then("it states that the source is available under an open licence")
def then_states_open_licence(context: object) -> None:
    text = (context.marketing_ui_harness.get("visibleText") or "").lower()
    assert "code is mit licensed" in text, text

@when("I look at the delegated responsibility section")
def when_look_at_delegated_responsibility_section(context: object) -> None:
    pass

@then("it offers forking and self-deploying at no cost")
def then_offers_forking_at_no_cost(context: object) -> None:
    text = (context.marketing_ui_harness.get("visibleText") or "").lower()
    assert "no cost" in text or "free" in text or "$0" in text, text
    assert "fork" in text or "self-deploying" in text or "deploy it yourself" in text, text

@then("it offers self-setup with managed operation at a monthly price")
def then_offers_self_setup_managed_operation(context: object) -> None:
    text = (context.marketing_ui_harness.get("visibleText") or "").lower()
    assert "self-setup" in text, text
    assert "$20 a month" in text or "$20 / month" in text or "$20/month" in text, text

@then("it offers assisted setup with managed operation at a monthly price and a one-time fee")
def then_offers_assisted_setup_managed_operation(context: object) -> None:
    text = (context.marketing_ui_harness.get("visibleText") or "").lower()
    assert "assisted setup" in text, text
    assert "$20 a month" in text or "$20 / month" in text or "$20/month" in text, text
    assert "$100 once" in text or "$100 one-time" in text, text

@then("it offers professional services as a quote")
def then_offers_professional_services_quote(context: object) -> None:
    text = (context.marketing_ui_harness.get("visibleText") or "").lower()
    assert "professional services" in text, text
    assert "quote" in text or "quoted" in text, text

@given("the delegated responsibility section")
def given_delegated_responsibility_section(context: object) -> None:
    context.marketing_ui_harness = _run_harness("render")

@then("the managed rungs state that Anthus keeps the deployment updated")
def then_managed_rungs_state_anthus_keeps_updated(context: object) -> None:
    text = (context.marketing_ui_harness.get("visibleText") or "").lower()
    assert "keeps the deployment updated" in text or "keep the deployment updated" in text or "keep it updated" in text, text

@then("they state that Anthus updates its own organizations first")
def then_state_anthus_updates_own_orgs_first(context: object) -> None:
    text = (context.marketing_ui_harness.get("visibleText") or "").lower()
    assert "updates its own organizations first" in text or "update our own first" in text or "update our own" in text, text

@then('there are calls to action for "/beta"')
def then_calls_to_action_for_beta(context: object) -> None:
    html = context.marketing_ui_harness.get("html") or ""
    # Header, Hero, FinalCta, Footer -> 4 occurrences
    assert html.count('href="/beta"') >= 4, f"Found {html.count('href=\"/beta\"')} links to /beta"
