"""Behave steps for web SPA organization signup and welcome screens."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from behave import given, then, when

REPO_ROOT = Path(__file__).resolve().parents[2]
WEB_DIR = REPO_ROOT / "web"
HARNESS = WEB_DIR / "test-support" / "membership-ui-harness.ts"
HARNESS_STATE = REPO_ROOT / ".membership-ui-harness-state.json"


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


def _run_harness(command: str, payload: dict | None = None) -> dict:
    tsx = _tsx_binary()
    args = [str(tsx), str(HARNESS), command]
    if payload is not None:
        args.append(json.dumps(payload))
    env = {
        **dict(__import__("os").environ),
        "CHATTICUS_MEMBERSHIP_UI_HARNESS_STATE": str(HARNESS_STATE),
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
            f"membership UI harness failed ({command}): "
            f"{result.stderr or result.stdout}"
        )
    return json.loads(result.stdout)


@given('the web SPA membership module with signup mode "{mode}"')
def given_membership_module(context: object, mode: str) -> None:
    context.membership_ui_harness = _run_harness(
        "reset",
        {"signup_mode": mode},
    )


@given('the web SPA has a signed-in session for "{email}"')
def given_signed_in_session(context: object, email: str) -> None:
    payload: dict[str, str] = {"email": email}
    token = getattr(context, "web_id_token", None)
    if token:
        payload["id_token"] = token
    context.membership_ui_harness = _run_harness("seed-session", payload)


@given("GET /me reports no organizations for that session")
def given_me_reports_no_orgs(context: object) -> None:
    context.membership_ui_harness = _run_harness("set-me-empty")


@when("the web SPA renders the membership shell")
def when_render_membership_shell(context: object) -> None:
    context.membership_ui_harness = _run_harness("render-shell")


@when('the web SPA submits organization name "{name}"')
def when_submit_organization_name(context: object, name: str) -> None:
    api_base = getattr(context, "web_api_base", None)
    if api_base is None:
        raise AssertionError("web API base is not wired for this scenario")
    payload: dict[str, str] = {"name": name, "api_base": api_base}
    token = getattr(context, "web_id_token", None)
    if token:
        payload["id_token"] = token
    context.membership_ui_harness = _run_harness("submit-organization", payload)


@then("the web SPA shows the create organization form")
def then_shows_create_form(context: object) -> None:
    harness = context.membership_ui_harness
    assert harness.get("view") == "create-organization", harness


@then("the web SPA does not show the invitation-only panel")
def then_not_invitation_panel(context: object) -> None:
    harness = context.membership_ui_harness
    assert harness.get("view") != "invitation-only", harness


@then("the web SPA shows the invitation-only panel")
def then_shows_invitation_panel(context: object) -> None:
    harness = context.membership_ui_harness
    assert harness.get("view") == "invitation-only", harness


@then("the web SPA does not show the create organization form")
def then_not_create_form(context: object) -> None:
    harness = context.membership_ui_harness
    assert harness.get("view") != "create-organization", harness


@then("the web SPA shows the welcome screen")
def then_shows_welcome(context: object) -> None:
    harness = context.membership_ui_harness
    assert harness.get("view") == "welcome", harness


@then("the web SPA does not show a queue position")
def then_no_queue_position(context: object) -> None:
    harness = context.membership_ui_harness
    text = (harness.get("visibleText") or "").lower()
    forbidden = ("queue", "position", "you are #", "you are number")
    assert not any(fragment in text for fragment in forbidden), harness


@then("the web SPA does not promise email notification")
def then_no_email_promise(context: object) -> None:
    harness = context.membership_ui_harness
    text = (harness.get("visibleText") or "").lower()
    forbidden = (
        "we will email",
        "we'll email",
        "email you when",
        "notify you by email",
    )
    assert not any(fragment in text for fragment in forbidden), harness
