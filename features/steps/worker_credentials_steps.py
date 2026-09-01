"""Behave steps for per-worker bearer credentials."""

from __future__ import annotations

from datetime import timedelta

from behave import given, then, when
from worker_http_helpers import (
    register_worker_http,
    worker_auth_headers,
)

from chatticus.control_plane import ControlPlane
from chatticus.http.app import INVOKE_HEADER, create_app
from chatticus.http.paths import org_path
from chatticus.http.principal import resolve_worker_bearer
from chatticus.http.test_server import start_test_server
from chatticus.models import MemberRole, OrganizationStatus
from chatticus.principal import Principal, PrincipalKind


@given('an empty control plane with invoke key "{invoke_key}"')
def given_empty_control_plane_with_invoke_key(context: object, invoke_key: str) -> None:
    context.plane = ControlPlane(heartbeat_timeout=timedelta(seconds=30))
    context.api_app = create_app(context.plane, invoke_key=invoke_key)
    context.api_client = start_test_server(context.api_app)
    context.api_client.headers[INVOKE_HEADER] = invoke_key
    context.bots_by_name = {}
    context.worker_tokens = {}


@given("a worker registered over HTTP as:")
def given_worker_registered_over_http(context: object) -> None:
    register_worker_http(context, context.table)


@when("a worker registers over HTTP:")
def when_worker_registers_over_http(context: object) -> None:
    context.previous_worker_token = getattr(context, "last_worker_token", None)
    register_worker_http(context, context.table)


@then("the registration response includes a worker token")
def then_registration_includes_token(context: object) -> None:
    assert context.last_worker_token
    assert len(context.last_worker_token) >= 32


@then("the registration response includes a new worker token")
def then_registration_includes_new_token(context: object) -> None:
    assert context.last_worker_token
    assert context.last_worker_token != context.previous_worker_token


@then("the previous worker token is rejected on worker routes")
def then_previous_token_rejected(context: object) -> None:
    tenant_id = "anthus"
    response = context.api_client.post(
        org_path(tenant_id, "/turns/missing-turn/claim"),
        json={"worker_id": context.last_worker_id},
        headers={"Authorization": f"Bearer {context.previous_worker_token}"},
    )
    assert response.status_code == 403


@when("the worker claims the turn over HTTP")
def when_worker_claims_turn_over_http(context: object) -> None:
    channel = context.last_channel
    turn_id = context.last_turn_id
    headers = worker_auth_headers(context, context.last_worker_id)
    response = context.api_client.post(
        org_path(channel.tenant_id, f"/turns/{turn_id}/claim"),
        json={"worker_id": context.last_worker_id},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    context.fence_token = int(response.json()["fence_token"])


@when('the worker posts chunk "{token}" completing the turn over HTTP')
def when_worker_posts_chunk_completing(context: object, token: str) -> None:
    channel = context.last_channel
    turn_id = context.last_turn_id
    headers = worker_auth_headers(context, context.last_worker_id)
    response = context.api_client.post(
        org_path(channel.tenant_id, f"/turns/{turn_id}/chunks"),
        json={
            "token": token,
            "complete": True,
            "fence_token": context.fence_token,
        },
        headers=headers,
    )
    assert response.status_code == 200, response.text


@when("a worker route is called without a bearer credential")
def when_worker_route_without_bearer(context: object) -> None:
    channel = context.last_channel
    turn_id = context.last_turn_id
    context.worker_route_response = context.api_client.post(
        org_path(channel.tenant_id, f"/turns/{turn_id}/claim"),
        json={"worker_id": "missing-credential-worker"},
    )


@when("a worker route is called with only the invoke key")
def when_worker_route_with_invoke_key_only(context: object) -> None:
    channel = context.last_channel
    turn_id = context.last_turn_id
    context.worker_route_response = context.api_client.post(
        org_path(channel.tenant_id, f"/turns/{turn_id}/claim"),
        json={"worker_id": "invoke-only-worker"},
        headers={INVOKE_HEADER: context.api_app.state.chatticus.invoke_key},
    )


@then("the worker route responds with status {status:d}")
def then_worker_route_status(context: object, status: int) -> None:
    assert context.worker_route_response.status_code == status


@when("the worker bearer credential is used on a browser route")
def when_worker_token_on_browser_route(context: object) -> None:
    headers = worker_auth_headers(context, context.last_worker_id)
    context.browser_route_response = context.api_client.post(
        org_path("anthus", "/channels"),
        json={"user_id": "ryan", "bot_ids": []},
        headers=headers,
    )


@then("the browser route responds with status {status:d}")
def then_browser_route_status(context: object, status: int) -> None:
    assert context.browser_route_response.status_code == status


@when("a user principal calls a worker route")
def when_user_principal_calls_worker_route(context: object) -> None:
    channel = context.last_channel
    turn_id = context.last_turn_id

    async def fake_user_principal(_request: object, _tenant_id: str) -> Principal:
        return Principal(
            kind=PrincipalKind.USER,
            tenant_id=channel.tenant_id,
            user_id="ryan",
            organization_status=OrganizationStatus.ENABLED,
            role=MemberRole.OWNER,
        )

    context.api_app.dependency_overrides[resolve_worker_bearer] = fake_user_principal
    context.worker_route_response = context.api_client.post(
        org_path(channel.tenant_id, f"/turns/{turn_id}/claim"),
        json={"worker_id": "user-principal-worker"},
        headers={"Authorization": "Bearer not-a-worker-token"},
    )
    context.api_app.dependency_overrides.pop(resolve_worker_bearer, None)


@when("the worker bearer credential is used on a worker route")
def when_worker_credential_on_worker_route(context: object) -> None:
    tenant_id = getattr(context, "last_worker_tenant_id", "anthus")
    headers = worker_auth_headers(context, context.last_worker_id)
    context.worker_route_response = context.api_client.post(
        org_path(tenant_id, f"/workers/{context.last_worker_id}/heartbeat"),
        headers=headers,
    )
