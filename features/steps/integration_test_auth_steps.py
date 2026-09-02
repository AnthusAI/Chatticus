"""Behave steps for integration-test session exchange."""

from __future__ import annotations

from datetime import timedelta

from behave import given, then, when
from browser_auth_helpers import wire_test_http_front_door
from http_test_support import NOW

from chatticus.control_plane import ControlPlane
from chatticus.http.app import INVOKE_HEADER
from chatticus.http.integration_test_auth import (
    DEFAULT_INTEGRATION_TEST_OWNER_EMAIL,
    INTEGRATION_TEST_SESSION_PATH,
    IntegrationTestAuthConfig,
    behave_caller_verifier,
    integration_test_hmac_secret,
    load_integration_test_auth_config,
    mint_integration_test_token,
    mint_integration_test_token_expired,
    seed_integration_test_organization,
)
from chatticus.http.paths import org_path
from chatticus.models import ActorKind


def _integration_config(context: object) -> IntegrationTestAuthConfig:
    config = getattr(context, "integration_test_auth", None)
    assert config is not None, "integration test auth is not configured"
    return config


@given('integration test auth is enabled for environment "{environment}"')
def given_integration_test_auth_enabled(context: object, environment: str) -> None:
    context.integration_test_environment = environment
    if getattr(context, "plane", None) is None:
        context.plane = ControlPlane(heartbeat_timeout=timedelta(seconds=30))
    context.bots_by_name = getattr(context, "bots_by_name", {})
    context.worker_tokens = getattr(context, "worker_tokens", {})


@given('integration test auth allows role "{role_arn}"')
def given_integration_test_allowed_role(context: object, role_arn: str) -> None:
    context.integration_test_allowed_role = role_arn


@given('tenant "{tenant_id}" is seeded for integration test user "{user_id}"')
def given_integration_test_tenant_seeded(
    context: object, tenant_id: str, user_id: str
) -> None:
    seed_integration_test_organization(
        context.plane,
        tenant_id=tenant_id,
        user_id=user_id,
        owner_email=DEFAULT_INTEGRATION_TEST_OWNER_EMAIL,
        now=NOW,
    )
    context.integration_test_tenant_id = tenant_id
    context.integration_test_user_id = user_id
    invoke_key = getattr(context, "integration_test_invoke_key", "integration-test-key")
    environment = getattr(context, "integration_test_environment", "development")
    context.integration_test_auth = IntegrationTestAuthConfig(
        enabled=True,
        environment=environment,
        allowed_role_arn=context.integration_test_allowed_role,
        tenant_id=tenant_id,
        user_id=user_id,
        hmac_secret=integration_test_hmac_secret(invoke_key),
        caller_verifier=behave_caller_verifier,
        now=lambda: NOW,
    )
    wire_test_http_front_door(
        context,
        context.plane,
        invoke_key=invoke_key,
        environment=environment,
        integration_test_auth=context.integration_test_auth,
    )
    context.api_client.headers[INVOKE_HEADER] = invoke_key


@given("the integration test front door is wired")
def given_integration_test_front_door_wired(context: object) -> None:
    if getattr(context, "plane", None) is None:
        context.plane = ControlPlane(heartbeat_timeout=timedelta(seconds=30))
    invoke_key = getattr(context, "integration_test_invoke_key", "integration-test-key")
    environment = getattr(context, "integration_test_environment", "development")
    integration_test_auth = load_integration_test_auth_config(
        environment=environment,
        invoke_key=invoke_key,
        allowed_role_arn=getattr(context, "integration_test_allowed_role", ""),
        caller_verifier=behave_caller_verifier,
    )
    context.integration_test_auth = integration_test_auth
    wire_test_http_front_door(
        context,
        context.plane,
        invoke_key=invoke_key,
        environment=environment,
        integration_test_auth=integration_test_auth,
    )
    context.raw_api_client.headers[INVOKE_HEADER] = invoke_key


@when('the integration test client requests a session with role "{role_arn}"')
def when_integration_test_session_with_role(context: object, role_arn: str) -> None:
    context.integration_test_session_response = context.raw_api_client.post(
        INTEGRATION_TEST_SESSION_PATH,
        headers={"X-Chatticus-Integration-Test-Role": role_arn},
    )


@when("the integration test client requests a session without caller credentials")
def when_integration_test_session_unsigned(context: object) -> None:
    context.integration_test_session_response = context.raw_api_client.post(
        INTEGRATION_TEST_SESSION_PATH,
    )


@then("the integration test session response status is {status:d}")
def then_integration_test_session_status(context: object, status: int) -> None:
    response = context.integration_test_session_response
    assert response.status_code == status, response.text


@then("the integration test session response includes a bearer token")
def then_integration_test_session_includes_token(context: object) -> None:
    body = context.integration_test_session_response.json()
    assert body.get("token")
    context.integration_test_bearer = body["token"]


@given("the integration test client has a session bearer token")
def given_integration_test_bearer(context: object) -> None:
    config = _integration_config(context)
    context.integration_test_bearer = mint_integration_test_token(config)


@given("the integration test client has an expired session bearer token")
def given_integration_test_expired_bearer(context: object) -> None:
    config = _integration_config(context)
    context.integration_test_bearer = mint_integration_test_token_expired(config)


def _integration_headers(context: object) -> dict[str, str]:
    token = getattr(context, "integration_test_bearer", "")
    assert token, "integration test bearer token is missing"
    return {"Authorization": f"Bearer {token}"}


@when('the integration test client creates a channel with bot "{bot_name}"')
def when_integration_test_create_channel(context: object, bot_name: str) -> None:
    tenant_id = context.integration_test_tenant_id
    user_id = context.integration_test_user_id
    if bot_name not in context.bots_by_name:
        bot_response = context.raw_api_client.post(
            org_path(tenant_id, "/bots"),
            json={"name": bot_name},
            headers=_integration_headers(context),
        )
        if bot_response.status_code != 200:
            context.integration_test_channel_response = bot_response
            return
        context.bots_by_name[bot_name] = bot_response.json()
    bot = context.bots_by_name[bot_name]
    context.integration_test_channel_response = context.raw_api_client.post(
        org_path(tenant_id, "/channels"),
        json={"user_id": user_id, "bot_ids": [bot["bot_id"]]},
        headers=_integration_headers(context),
    )
    if context.integration_test_channel_response.status_code == 200:
        context.integration_test_channel = (
            context.integration_test_channel_response.json()
        )


@when(
    'the integration test client creates a channel for user "{user_id}" '
    'with bot "{bot_name}"'
)
def when_integration_test_create_channel_for_user(
    context: object, user_id: str, bot_name: str
) -> None:
    tenant_id = context.integration_test_tenant_id
    if bot_name not in context.bots_by_name:
        bot_response = context.raw_api_client.post(
            org_path(tenant_id, "/bots"),
            json={"name": bot_name},
            headers=_integration_headers(context),
        )
        if bot_response.status_code != 200:
            context.integration_test_channel_response = bot_response
            return
        context.bots_by_name[bot_name] = bot_response.json()
    bot = context.bots_by_name[bot_name]
    context.integration_test_channel_response = context.raw_api_client.post(
        org_path(tenant_id, "/channels"),
        json={"user_id": user_id, "bot_ids": [bot["bot_id"]]},
        headers=_integration_headers(context),
    )


@then("the integration test channel response status is {status:d}")
def then_integration_test_channel_status(context: object, status: int) -> None:
    response = context.integration_test_channel_response
    assert response.status_code == status, response.text


@when('the integration test client posts "{body}" addressed to bot "{bot_name}"')
def when_integration_test_post_message(
    context: object, body: str, bot_name: str
) -> None:
    tenant_id = context.integration_test_tenant_id
    user_id = context.integration_test_user_id
    channel = context.integration_test_channel
    bot = context.bots_by_name[bot_name]
    context.integration_test_post_response = context.raw_api_client.post(
        org_path(tenant_id, f"/channels/{channel['channel_id']}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": user_id,
            "body": body,
            "addressed_to_bot_id": bot["bot_id"],
        },
        headers=_integration_headers(context),
    )


@then("the integration test post message response status is {status:d}")
def then_integration_test_post_status(context: object, status: int) -> None:
    response = context.integration_test_post_response
    assert response.status_code == status, response.text


@when('the integration test client claims turn "{turn_id}" as worker "{worker_id}"')
def when_integration_test_claim_turn(
    context: object, turn_id: str, worker_id: str
) -> None:
    tenant_id = context.integration_test_tenant_id
    context.integration_test_worker_route_response = context.raw_api_client.post(
        org_path(tenant_id, f"/turns/{turn_id}/claim"),
        json={"worker_id": worker_id},
        headers=_integration_headers(context),
    )


@then("the integration test worker route response status is {status:d}")
def then_integration_test_worker_route_status(context: object, status: int) -> None:
    response = context.integration_test_worker_route_response
    assert response.status_code == status, response.text
