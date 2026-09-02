"""Behave steps for GET /me membership snapshot."""

from __future__ import annotations

from datetime import UTC, datetime

from behave import given, then, when
from cognito_test_support import make_cognito_test_keys, mint_id_token

from chatticus.control_plane import ControlPlane
from chatticus.http.app import create_app
from chatticus.http.test_server import start_test_server

NOW = datetime(2026, 8, 31, 12, 0, 0, tzinfo=UTC)


@given('the me front door has tenant "{tenant_id}" enabled for "{email}"')
def given_me_front_door_enabled_tenant(
    context: object, tenant_id: str, email: str
) -> None:
    _keys(context)
    context.plane = ControlPlane()
    context.plane.admin_seed_organization(
        tenant_id,
        email,
        name="Test Org",
        now=NOW,
    )
    context.orgs_by_name = {}
    context.identities_by_email = {}
    context.current_identity = None
    context.now = NOW
    context.plane.set_now(context.now)
    _wire_me_app(context)


def _keys(context: object) -> object:
    keys = getattr(context, "cognito_test_keys", None)
    if keys is None:
        keys = make_cognito_test_keys()
        context.cognito_test_keys = keys
    return keys


def _close_client(context: object) -> None:
    client = getattr(context, "api_client", None)
    if client is not None:
        client.close()


@given("a Cognito-verified HTTP front door")
def given_cognito_verified_front_door(context: object) -> None:
    _keys(context)
    context.plane = ControlPlane()
    context.orgs_by_name = {}
    context.identities_by_email = {}
    context.current_identity = None
    context.now = NOW
    context.plane.set_now(context.now)
    _wire_me_app(context)


def _wire_me_app(context: object) -> None:
    _close_client(context)
    app = create_app(
        context.plane,
        invoke_key="",
        cognito_verifier=_keys(context).verifier(),
    )
    context.api_app = app
    context.api_client = start_test_server(app)


@given("an HTTP front door without a Cognito verifier")
def given_front_door_without_cognito_verifier(context: object) -> None:
    _close_client(context)
    context.plane = ControlPlane()
    app = create_app(context.plane, invoke_key="")
    context.api_app = app
    context.api_client = start_test_server(app)


@given('"{email}" has signed in on the me front door')
def given_signed_in_on_me_front_door(context: object, email: str) -> None:
    identity = context.plane.sign_in(email, now=context.now)
    context.current_identity = identity
    context.identities_by_email[email] = identity


@when("GET /me is called without Authorization")
def when_get_me_without_auth(context: object) -> None:
    context.me_response = context.api_client.get("/me")


@when('GET /me is called with bearer token "{token}"')
def when_get_me_with_raw_token(context: object, token: str) -> None:
    context.me_response = context.api_client.get(
        "/me",
        headers={"Authorization": f"Bearer {token}"},
    )


@when('GET /me is called with a valid id token for "{email}"')
def when_get_me_with_valid_token(context: object, email: str) -> None:
    token = mint_id_token(_keys(context), email=email)
    context.me_response = context.api_client.get(
        "/me",
        headers={"Authorization": f"Bearer {token}"},
    )


@when('GET /me is called with an expired id token for "{email}"')
def when_get_me_with_expired_token(context: object, email: str) -> None:
    token = mint_id_token(
        _keys(context),
        email=email,
        expires_at=datetime(2020, 1, 1, tzinfo=UTC),
    )
    context.me_response = context.api_client.get(
        "/me",
        headers={"Authorization": f"Bearer {token}"},
    )


@then("GET /me responds with status {status:d}")
def then_me_status(context: object, status: int) -> None:
    assert context.me_response.status_code == status, context.me_response.text


@then('GET /me email is "{email}"')
def then_me_email(context: object, email: str) -> None:
    payload = context.me_response.json()
    assert payload["email"] == email


@then("GET /me user id is empty")
def then_me_user_id_empty(context: object) -> None:
    payload = context.me_response.json()
    assert payload["user_id"] is None


@then("GET /me user id is present")
def then_me_user_id_present(context: object) -> None:
    payload = context.me_response.json()
    assert isinstance(payload["user_id"], str)
    assert payload["user_id"]


@then("GET /me organizations are empty")
def then_me_orgs_empty(context: object) -> None:
    payload = context.me_response.json()
    assert payload["organizations"] == []


@then('GET /me organizations include one with status "{status}"')
def then_me_orgs_include_status(context: object, status: str) -> None:
    payload = context.me_response.json()
    organizations = payload["organizations"]
    assert len(organizations) == 1
    assert organizations[0]["status"] == status


@then("GET /me organizations include:")
def then_me_orgs_include_table(context: object) -> None:
    payload = context.me_response.json()
    organizations = payload["organizations"]
    expected = [
        {"tenant_id": row["tenant_id"], "status": row["status"]}
        for row in context.table
    ]
    assert organizations == expected
