"""Behave steps for web SPA Google sign-in and sign-out."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from behave import given, then, when

REPO_ROOT = Path(__file__).resolve().parents[2]
WEB_DIR = REPO_ROOT / "web"
HARNESS = WEB_DIR / "test-support" / "auth-behavior-harness.ts"
HARNESS_STATE = REPO_ROOT / ".auth-harness-state.json"


def _run_harness(command: str, payload: dict | None = None) -> dict:
    tsx = WEB_DIR / "node_modules" / ".bin" / "tsx"
    args = [str(tsx), str(HARNESS), command]
    if payload is not None:
        args.append(json.dumps(payload))
    env = {
        **dict(__import__("os").environ),
        "CHATTICUS_AUTH_HARNESS_STATE": str(HARNESS_STATE),
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
            f"auth harness failed ({command}): {result.stderr or result.stdout}"
        )
    return json.loads(result.stdout)


@given("the web SPA Cognito auth module")
def given_web_spa_cognito_auth_module(context: object) -> None:
    context.web_auth_harness = _run_harness("reset")


@given('the web SPA has an active signed-in session with id_token "{token}"')
def given_active_signed_in_session(context: object, token: str) -> None:
    context.web_auth_harness = _run_harness(
        "seed-session",
        {"id_token": token},
    )


@given("the web SPA is completing a Cognito sign-out redirect")
def given_completing_sign_out_redirect(context: object) -> None:
    context.web_auth_harness = _run_harness("seed-signout-callback")


@when("the person signs out from the web SPA")
def when_person_signs_out(context: object) -> None:
    context.web_auth_harness = _run_harness("sign-out")


@when("the person starts Google sign-in from the web SPA")
def when_person_starts_google_sign_in(context: object) -> None:
    context.web_auth_harness = _run_harness("sign-in")


@when("the sign-out redirect callback is handled")
def when_sign_out_callback_handled(context: object) -> None:
    context.web_auth_harness = _run_harness("complete-sign-out")


@then('the web SPA begins Cognito sign-out redirect with id_token_hint "{token}"')
def then_sign_out_redirect_with_hint(context: object, token: str) -> None:
    harness = context.web_auth_harness
    assert harness.get("signoutRedirectCalled") is True, harness
    args = harness.get("signoutRedirectArgs") or {}
    assert args.get("id_token_hint") == token, harness


@then("the web SPA does not clear the session with removeUser only")
def then_not_remove_user_only(context: object) -> None:
    harness = context.web_auth_harness
    assert harness.get("signoutRedirectCalled") is True, harness
    assert harness.get("removeUserBeforeRedirect") is not True, harness


@then('the Google authorization request includes prompt "{prompt}"')
def then_sign_in_includes_prompt(context: object, prompt: str) -> None:
    harness = context.web_auth_harness
    assert harness.get("signinRedirectCalled") is True, harness
    extra = harness.get("signinExtraQueryParams") or {}
    assert extra.get("prompt") == prompt, harness


@then("the web SPA in-memory session is cleared")
def then_in_memory_session_cleared(context: object) -> None:
    harness = context.web_auth_harness
    assert harness.get("sessionCleared") is True, harness
