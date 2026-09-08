"""Behave steps for creating bots from the enabled workspace web SPA."""

from __future__ import annotations

from behave import given, then, when
from cognito_test_support import mint_id_token
from me_steps import _keys
from organization_steps import _org_by_name
from web_organization_signup_steps import _run_harness

from chatticus.http.paths import org_path

CREATE_BOT_FORM_TITLE = "Create a bot"


@given('the enabled workspace web SPA for "{email}" in "{name}"')
def given_enabled_workspace_web_spa(context: object, email: str, name: str) -> None:
    from create_organization_steps import given_open_signup_wired_to_web
    from invite_organization_steps import given_web_enabled_org_session
    from me_steps import given_signed_in_on_me_front_door
    from members_cli_steps import when_members_cli_enables
    from organization_steps import given_created_org
    from web_organization_signup_steps import when_render_membership_shell

    given_open_signup_wired_to_web(context)
    given_signed_in_on_me_front_door(context, email)
    given_created_org(context, name)
    when_members_cli_enables(context, name)
    given_web_enabled_org_session(context, email, name)
    when_render_membership_shell(context)
    harness = context.membership_ui_harness
    assert harness.get("view") == "enabled-workspace", harness
    text = harness.get("visibleText") or ""
    assert CREATE_BOT_FORM_TITLE in text, harness


def _harness_payload(context: object) -> dict[str, str]:
    api_base = getattr(context, "web_api_base", None)
    token = getattr(context, "web_id_token", None)
    if api_base is None or token is None:
        raise AssertionError(
            "web API base and id token must be wired for this scenario"
        )
    return {"api_base": api_base, "id_token": token}


@when('the web SPA uses a signed-in session for "{email}"')
def when_web_spa_session_for_email(context: object, email: str) -> None:
    token = mint_id_token(_keys(context), email=email)
    context.web_id_token = token
    context.membership_ui_harness = _run_harness(
        "seed-session",
        {"email": email, "id_token": token},
    )


@when('the web SPA creates bot "{name}"')
def when_web_spa_creates_bot(context: object, name: str) -> None:
    payload = _harness_payload(context)
    payload["name"] = name
    context.membership_ui_harness = _run_harness("submit-create-bot", payload)


@when("the web SPA tries to create a bot with an empty name")
def when_web_spa_tries_empty_bot(context: object) -> None:
    payload = _harness_payload(context)
    payload["name"] = "   "
    context.membership_ui_harness = _run_harness("submit-create-bot", payload)


@then('the web SPA shows create bot confirmation for "{name}"')
def then_web_create_bot_confirmation(context: object, name: str) -> None:
    harness = context.membership_ui_harness
    expected = f"Created {name}."
    assert harness.get("createBotConfirmation") == expected, harness


@then("the web SPA workspace roster shows:")
def then_web_workspace_roster_shows(context: object) -> None:
    harness = context.membership_ui_harness
    expected: list[str] = []
    if context.table.headings and context.table.headings[0].strip():
        expected.append(context.table.headings[0].strip())
    expected.extend(row.cells[0].strip() for row in context.table)
    expected = [name for name in expected if name]
    assert harness.get("workspaceBotNames") == expected, harness


@then("the web SPA workspace roster is empty")
def then_web_workspace_roster_empty(context: object) -> None:
    harness = context.membership_ui_harness
    assert harness.get("workspaceBotNames") == [], harness


@then("the web SPA shows a create bot error")
def then_web_create_bot_error(context: object) -> None:
    harness = context.membership_ui_harness
    assert harness.get("createBotError"), harness


@then("the web SPA did not call create bot")
def then_web_did_not_call_create_bot(context: object) -> None:
    harness = context.membership_ui_harness
    assert harness.get("createBotBlocked") is True, harness
    assert harness.get("createBotConfirmation") is None, harness


@then("the web SPA shows the create bot form")
def then_web_shows_create_bot_form(context: object) -> None:
    harness = context.membership_ui_harness
    text = harness.get("visibleText") or ""
    assert CREATE_BOT_FORM_TITLE in text, harness


@then("the web SPA does not show the create bot form")
def then_web_does_not_show_create_bot_form(context: object) -> None:
    harness = context.membership_ui_harness
    text = harness.get("visibleText") or ""
    assert CREATE_BOT_FORM_TITLE not in text, harness


@when('POST /bots is called with an empty name for organization "{name}"')
def when_post_bots_empty_name(context: object, name: str) -> None:
    org = _org_by_name(context, name)
    token = context.web_id_token
    assert token is not None
    context.create_bot_response = context.api_client.post(
        org_path(org.tenant_id, "/bots"),
        json={"name": "   "},
        headers={"Authorization": f"Bearer {token}"},
    )


@then("POST /bots responds with status {status:d}")
def then_post_bots_status(context: object, status: int) -> None:
    response = context.create_bot_response
    assert response is not None
    assert response.status_code == status, response.text
