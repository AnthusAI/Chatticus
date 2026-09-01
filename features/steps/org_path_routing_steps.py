"""Behave steps for organization path routing."""

from __future__ import annotations

from behave import then, when

from chatticus.http.paths import org_path
from chatticus.models import ChannelTenantMismatchError


@when(
    'the front door receives POST /orgs/{tenant_id}/channels for user "{user_id}" '
    "with bots:"
)
def when_post_org_channels(context: object, tenant_id: str, user_id: str) -> None:
    bot_ids = [
        context.bots_by_name[row.cells[0].strip()].bot_id for row in context.table
    ]
    response = context.api_client.post(
        org_path(tenant_id, "/channels"),
        json={"user_id": user_id, "bot_ids": bot_ids},
    )
    context.last_http_response = response
    if response.status_code == 200:
        context.last_channel = context.plane.channel(
            tenant_id, response.json()["channel_id"]
        )


@then('the channel response has tenant_id "{tenant_id}"')
def then_channel_response_tenant(context: object, tenant_id: str) -> None:
    response = context.last_http_response
    assert response.status_code == 200, response.text
    assert response.json()["tenant_id"] == tenant_id


@when(
    "the front door receives GET /orgs/{tenant_id}/users/{user_id}/bots with header "
    "X-Tenant-Id {header_tenant}"
)
def when_get_bots_with_tenant_header(
    context: object, tenant_id: str, user_id: str, header_tenant: str
) -> None:
    response = context.api_client.get(
        org_path(tenant_id, f"/users/{user_id}/bots"),
        headers={"X-Tenant-Id": header_tenant},
    )
    context.last_http_response = response


@then("the front door rejects X-Tenant-Id")
def then_front_door_rejects_tenant_header(context: object) -> None:
    response = context.last_http_response
    assert response.status_code == 400, response.text
    assert "X-Tenant-Id" in response.json()["detail"]


@when('tenant "{tenant_id}" posts "{body}" on the channel via org path "{org_tenant}"')
def when_tenant_posts_via_org_path(
    context: object, tenant_id: str, body: str, org_tenant: str
) -> None:
    channel = context.last_channel
    context.message_error = None
    response = context.api_client.post(
        org_path(org_tenant, f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": "human",
            "author_id": "intruder",
            "body": body,
        },
    )
    if response.status_code == 403:
        context.message_error = ChannelTenantMismatchError(response.json()["detail"])
    elif response.status_code >= 400:
        context.message_error = response
    else:
        context.message_error = None
        context.last_turn_id = response.json().get("turn_id")
