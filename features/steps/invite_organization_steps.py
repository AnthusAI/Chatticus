"""Behave steps for inviting people into enabled organizations."""

from __future__ import annotations

from datetime import timedelta

from behave import given, step, then, when
from cognito_test_support import mint_id_token
from me_steps import _keys
from organization_steps import _org_by_name, _plane
from web_organization_signup_steps import _run_harness


@when('the owner of "{name}" invites "{email}" via the HTTP front door')
def when_owner_invites_via_http(context: object, name: str, email: str) -> None:
    org = _org_by_name(context, name)
    owner = context.current_identity
    assert owner is not None
    token = mint_id_token(_keys(context), email=owner.email)
    context.invite_response = context.api_client.post(
        f"/orgs/{org.tenant_id}/invitations",
        headers={"Authorization": f"Bearer {token}"},
        json={"email": email},
    )


@given('the owner of "{name}" has invited "{email}" via the HTTP front door')
def given_owner_invited_via_http(context: object, name: str, email: str) -> None:
    when_owner_invites_via_http(context, name, email)


@when('a member of "{name}" tries to invite "{email}" via the HTTP front door')
def when_member_tries_invite_via_http(context: object, name: str, email: str) -> None:
    org = _org_by_name(context, name)
    member = context.current_identity
    assert member is not None
    token = mint_id_token(_keys(context), email=member.email)
    context.invite_response = context.api_client.post(
        f"/orgs/{org.tenant_id}/invitations",
        headers={"Authorization": f"Bearer {token}"},
        json={"email": email},
    )


@when("the invitation TTL has elapsed")
def when_invitation_ttl_elapsed(context: object) -> None:
    context.now = context.now + timedelta(days=8)
    _plane(context).set_now(context.now)


@when('"{email}" is the current user on the me front door')
def when_email_is_current_user(context: object, email: str) -> None:
    from chatticus.org_records import normalize_email

    identity = _plane(context).get_identity_by_email(normalize_email(email))
    assert identity is not None
    context.current_identity = identity
    context.identities_by_email[email] = identity


@then("POST /orgs/invitations responds with status {status:d}")
def then_invite_status(context: object, status: int) -> None:
    response = context.invite_response
    assert response.status_code == status, response.text


@then("GET /me does not include a pending organization")
def then_me_no_pending_org(context: object) -> None:
    payload = context.me_response.json()
    pending = [
        organization
        for organization in payload["organizations"]
        if organization["status"] == "pending"
    ]
    assert pending == []


@when("the web SPA refreshes membership from GET /me")
def when_web_refresh_me(context: object) -> None:
    api_base = getattr(context, "web_api_base", None)
    if api_base is None:
        api_base = str(context.api_client.base_url)
    email = context.membership_ui_harness.get("email", "sam@example.com")
    token = getattr(context, "web_id_token", None)
    if token is None:
        token = mint_id_token(_keys(context), email=email)
    context.membership_ui_harness = _run_harness(
        "refresh-me-from-api",
        {
            "api_base": api_base,
            "id_token": token,
            "email": email,
        },
    )


@step('the web SPA has an enabled organization session for "{email}" in "{name}"')
def given_web_enabled_org_session(context: object, email: str, name: str) -> None:
    org = _org_by_name(context, name)
    token = mint_id_token(_keys(context), email=email)
    context.web_id_token = token
    context.web_api_base = str(context.api_client.base_url)
    _run_harness("seed-session", {"email": email, "id_token": token})
    context.membership_ui_harness = _run_harness(
        "set-me-enabled",
        {"tenant_id": org.tenant_id},
    )


@when('the web SPA owner of "{name}" invites "{email}"')
def when_web_owner_invites(context: object, name: str, email: str) -> None:
    org = _org_by_name(context, name)
    owner = context.current_identity
    assert owner is not None
    token = mint_id_token(_keys(context), email=owner.email)
    api_base = getattr(context, "web_api_base", str(context.api_client.base_url))
    context.membership_ui_harness = _run_harness(
        "submit-invitation",
        {
            "api_base": api_base,
            "id_token": token,
            "tenant_id": org.tenant_id,
            "email": email,
        },
    )


@then('the web SPA shows invite confirmation for "{email}"')
def then_web_invite_confirmation(context: object, email: str) -> None:
    from chatticus.org_records import normalize_email

    harness = context.membership_ui_harness
    normalized = normalize_email(email)
    expected = f"Invited {normalized} — they can sign in with that Google account."
    assert harness.get("inviteConfirmation") == expected, harness


@then("the web SPA shows the enabled workspace")
def then_web_enabled_workspace(context: object) -> None:
    harness = context.membership_ui_harness
    assert harness.get("view") == "enabled-workspace", harness


@then("the web SPA does not show the welcome screen")
def then_web_not_welcome(context: object) -> None:
    harness = context.membership_ui_harness
    assert harness.get("view") != "welcome", harness
