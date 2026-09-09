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
HARNESS_OIDC_STORE = REPO_ROOT / ".auth-harness-oidc-store.json"
HARNESS_SESSION_STORE = REPO_ROOT / ".auth-harness-session-store.json"


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
        "CHATTICUS_AUTH_HARNESS_STATE": str(HARNESS_STATE),
        "CHATTICUS_AUTH_HARNESS_OIDC_STORE": str(HARNESS_OIDC_STORE),
        "CHATTICUS_AUTH_HARNESS_SESSION_STORE": str(HARNESS_SESSION_STORE),
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


@given("the web SPA has no signed-in session")
def given_no_signed_in_session(context: object) -> None:
    context.web_auth_harness = _run_harness("seed-no-session")


@given("the web SPA IdP session is valid but no persisted OIDC user")
def given_idp_session_only(context: object) -> None:
    context.web_auth_harness = _run_harness("seed-idp-session-only")


@given("the web SPA has an expired id_token and a valid refresh token")
def given_expired_session_with_refresh(context: object) -> None:
    context.web_auth_harness = _run_harness("seed-expired-with-refresh")


@given("the web SPA has an active signed-in session")
def given_active_signed_in_session_default(context: object) -> None:
    context.web_auth_harness = _run_harness("seed-session", {})


@given('the web SPA has an active signed-in session with id_token "{token}"')
def given_active_signed_in_session(context: object, token: str) -> None:
    context.web_auth_harness = _run_harness(
        "seed-session",
        {"id_token": token},
    )


@given("the person has signed out of the web SPA")
def given_person_signed_out(context: object) -> None:
    _run_harness("sign-out")
    context.web_auth_harness = _run_harness("complete-sign-out")


@given("the web SPA is completing a Cognito sign-out redirect")
def given_completing_sign_out_redirect(context: object) -> None:
    context.web_auth_harness = _run_harness("seed-signout-callback")


@when("the person signs out from the web SPA")
def when_person_signs_out(context: object) -> None:
    context.web_auth_harness = _run_harness("sign-out")


@when("the person reloads the workspace")
def when_person_reloads_workspace(context: object) -> None:
    context.web_auth_harness = _run_harness("reload-workspace")


@when("the person starts Google sign-in from the web SPA")
def when_person_starts_google_sign_in(context: object) -> None:
    context.web_auth_harness = _run_harness("sign-in")


@when("the sign-out redirect callback is handled")
def when_sign_out_callback_handled(context: object) -> None:
    context.web_auth_harness = _run_harness("complete-sign-out")


@then("the web SPA navigates to Cognito hosted UI logout with client_id and logout_uri")
def then_sign_out_navigates_cognito_logout(context: object) -> None:
    harness = context.web_auth_harness
    url = harness.get("cognitoLogoutNavigationUrl")
    assert url is not None, harness
    assert "client_id=test-client-id" in url, harness
    assert (
        "logout_uri=" in url and "dev.chattic.us%2Fauth%2Fsignout-callback" in url
    ), harness


@then("the Cognito logout URL does not include identity_provider")
def then_cognito_logout_url_no_identity_provider(context: object) -> None:
    harness = context.web_auth_harness
    url = harness.get("cognitoLogoutNavigationUrl") or ""
    assert "identity_provider" not in url, harness


@then("the web SPA does not have a signed-in session")
def then_no_signed_in_session(context: object) -> None:
    harness = context.web_auth_harness
    assert harness.get("sessionPresent") is not True, harness


@then("the web SPA did not attempt silent sign-in")
def then_did_not_attempt_silent_sign_in(context: object) -> None:
    harness = context.web_auth_harness
    assert harness.get("signinSilentCalled") is not True, harness


@then('the web SPA begins Cognito sign-out redirect with id_token_hint "{token}"')
def then_sign_out_redirect_with_hint(context: object, token: str) -> None:
    harness = context.web_auth_harness
    assert harness.get("signoutRedirectCalled") is True, harness
    args = harness.get("signoutRedirectArgs") or {}
    assert args.get("id_token_hint") == token, harness


@then("the Cognito sign-out redirect includes client_id and logout_uri")
def then_sign_out_includes_cognito_params(context: object) -> None:
    harness = context.web_auth_harness
    args = harness.get("signoutRedirectArgs") or {}
    extra = args.get("extraQueryParams") or {}
    assert extra.get("client_id") == "test-client-id", harness
    assert (
        extra.get("logout_uri") == "https://dev.chattic.us/auth/signout-callback"
    ), harness


@then("the Cognito sign-out redirect does not include identity_provider")
def then_sign_out_no_identity_provider(context: object) -> None:
    harness = context.web_auth_harness
    args = harness.get("signoutRedirectArgs") or {}
    extra = args.get("extraQueryParams") or {}
    assert "identity_provider" not in extra, harness


@then("the web SPA does not clear the session with removeUser only")
def then_not_remove_user_only(context: object) -> None:
    harness = context.web_auth_harness
    assert harness.get("cognitoLogoutNavigationUrl") is not None, harness
    assert harness.get("removeUserBeforeRedirect") is not True, harness


@then("the web SPA still has that signed-in session")
def then_still_has_signed_in_session(context: object) -> None:
    harness = context.web_auth_harness
    assert harness.get("sessionPresent") is True, harness


@then("the person is not sent through Google sign-in")
def then_not_sent_through_google_sign_in(context: object) -> None:
    harness = context.web_auth_harness
    assert harness.get("signinRedirectCalled") is not True, harness


@then('the Google authorization request does not include prompt "{prompt}"')
def then_sign_in_does_not_include_prompt(context: object, prompt: str) -> None:
    harness = context.web_auth_harness
    assert harness.get("signinRedirectCalled") is True, harness
    extra = harness.get("signinExtraQueryParams") or {}
    assert extra.get("prompt") != prompt, harness


@then('the Google authorization request includes identity_provider "{provider}"')
def then_sign_in_includes_identity_provider(context: object, provider: str) -> None:
    harness = context.web_auth_harness
    assert harness.get("signinRedirectCalled") is True, harness
    extra = harness.get("signinExtraQueryParams") or {}
    assert extra.get("identity_provider") == provider, harness


@then("the web SPA attempted silent sign-in")
def then_attempted_silent_sign_in(context: object) -> None:
    harness = context.web_auth_harness
    assert harness.get("signinSilentCalled") is True, harness


@then('the Google authorization request includes prompt "{prompt}"')
def then_sign_in_includes_prompt(context: object, prompt: str) -> None:
    harness = context.web_auth_harness
    assert harness.get("signinRedirectCalled") is True, harness
    extra = harness.get("signinExtraQueryParams") or {}
    assert extra.get("prompt") == prompt, harness


@then("the web SPA persisted session is cleared")
def then_persisted_session_cleared(context: object) -> None:
    harness = context.web_auth_harness
    assert harness.get("sessionCleared") is True, harness
