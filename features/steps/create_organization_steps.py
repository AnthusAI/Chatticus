"""Behave steps for POST /organizations product signup."""

from __future__ import annotations

from datetime import UTC, datetime

from behave import given, then, when
from cognito_test_support import mint_id_token
from me_steps import _keys
from organization_steps import _org_by_name, _plane

from chatticus.control_plane import ControlPlane
from chatticus.http.app import create_app
from chatticus.http.test_server import start_test_server
from chatticus.signup_mode import SignupMode

NOW = datetime(2026, 8, 31, 12, 0, 0, tzinfo=UTC)


def _wire_front_door(context: object, *, signup_mode: SignupMode) -> None:
    _keys(context)
    if not getattr(context, "plane", None):
        context.plane = ControlPlane()
    context.orgs_by_name = getattr(context, "orgs_by_name", {}) or {}
    context.identities_by_email = getattr(context, "identities_by_email", {}) or {}
    context.current_identity = None
    context.now = NOW
    context.plane.set_now(context.now)
    client = getattr(context, "api_client", None)
    if client is not None:
        client.close()
    app = create_app(
        context.plane,
        invoke_key="",
        cognito_verifier=_keys(context).verifier(),
        signup_mode=signup_mode,
    )
    context.api_app = app
    context.api_client = start_test_server(app)
    context.signup_mode = signup_mode


@given("a Cognito-verified HTTP front door with open signup")
def given_open_signup_front_door(context: object) -> None:
    _wire_front_door(context, signup_mode=SignupMode.OPEN)


@given("a Cognito-verified HTTP front door with invitation-only signup")
def given_invitation_only_front_door(context: object) -> None:
    _wire_front_door(context, signup_mode=SignupMode.INVITATION_ONLY)


@given("a Cognito-verified HTTP front door with open signup wired to the web SPA")
def given_open_signup_wired_to_web(context: object) -> None:
    given_open_signup_front_door(context)
    context.web_api_base = str(context.api_client.base_url)
    context.web_id_token = mint_id_token(_keys(context), email="sam@example.com")


@when(
    'POST /organizations is called with a valid id token for "{email}" '
    'and name "{name}"'
)
def when_post_organizations(context: object, email: str, name: str) -> None:
    token = mint_id_token(_keys(context), email=email)
    context.create_org_response = context.api_client.post(
        "/organizations",
        headers={"Authorization": f"Bearer {token}"},
        json={"name": name},
    )
    context.create_org_name = name


@given('"{email}" has created organization "{name}" via the HTTP front door')
def given_created_via_http(context: object, email: str, name: str) -> None:
    when_post_organizations(context, email, name)
    assert (
        context.create_org_response.status_code == 201
    ), context.create_org_response.text
    payload = context.create_org_response.json()
    context.orgs_by_name[name] = _plane(context).get_organization(payload["tenant_id"])
    identity = _plane(context).sign_in(email, now=context.now)
    context.current_identity = identity
    context.identities_by_email[email] = identity


@then("POST /organizations responds with status {status:d}")
def then_post_organizations_status(context: object, status: int) -> None:
    response = context.create_org_response
    assert response.status_code == status, response.text


@then('POST /organizations body includes tenant_id and status "{status}"')
def then_post_organizations_body(context: object, status: str) -> None:
    payload = context.create_org_response.json()
    assert isinstance(payload.get("tenant_id"), str)
    assert payload["tenant_id"]
    assert payload["status"] == status
    org = _plane(context).get_organization(payload["tenant_id"])
    context.orgs_by_name[context.create_org_name] = org


@then('"{email}" is an owner member of "{name}"')
def then_email_is_owner(context: object, email: str, name: str) -> None:
    org = _org_by_name(context, name)
    identity = context.identities_by_email.get(email)
    if identity is None:
        identity = _plane(context).sign_in(email, now=context.now)
        context.identities_by_email[email] = identity
    membership = _plane(context)._messaging_store.get_membership(
        org.tenant_id, identity.user_id
    )
    assert membership is not None
    from chatticus.models import MemberRole

    assert membership.role == MemberRole.OWNER
