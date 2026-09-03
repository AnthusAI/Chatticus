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
