"""Step definitions for the chattic.us web UI API contract."""

from __future__ import annotations

from behave import then, when
from sse_helpers import SseWatcher, tenant_headers

from chatticus.models import TurnStatus


@when('the web UI requests the bot roster for tenant "{tenant_id}" user "{user_id}"')
def when_web_ui_requests_bot_roster(
    context: object, tenant_id: str, user_id: str
) -> None:
    response = context.api_client.get(
        f"/users/{user_id}/bots",
        headers=tenant_headers(tenant_id),
    )
    assert response.status_code == 200, response.text
    context.web_ui_bot_names = [bot["name"] for bot in response.json()["bots"]]


@then("the web UI bot roster shows:")
def then_web_ui_bot_roster_shows(context: object) -> None:
    expected: list[str] = []
    if context.table.headings and context.table.headings[0].strip():
        expected.append(context.table.headings[0].strip())
    expected.extend(row.cells[0].strip() for row in context.table)
    expected = [name for name in expected if name]
    assert context.web_ui_bot_names == expected


@when(
    'the web UI sends "{body}" from user "{user_id}" of tenant "{tenant_id}" '
    'addressed to bot "{name}"'
)
def when_web_ui_sends_message(
    context: object,
    body: str,
    user_id: str,
    tenant_id: str,
    name: str,
) -> None:
    channel = context.last_channel
    bot = context.bots_by_name[name]
    response = context.api_client.post(
        f"/channels/{channel.channel_id}/messages",
        json={
            "author_kind": "human",
            "author_id": user_id,
            "body": body,
            "addressed_to_bot_id": bot.bot_id,
        },
        headers=tenant_headers(tenant_id),
    )
    context.web_ui_post_response = response


@then("the message is accepted by the thin-turn front door")
def then_message_accepted_by_front_door(context: object) -> None:
    response = context.web_ui_post_response
    assert response.status_code == 200, response.text


@then("a turn is started for the message")
def then_turn_started_for_message(context: object) -> None:
    payload = context.web_ui_post_response.json()
    assert payload.get("turn_id")
    context.last_turn_id = payload["turn_id"]


@when('the web UI opens a turn stream for user "{user_id}" of tenant "{tenant_id}"')
def when_web_ui_opens_turn_stream(
    context: object, user_id: str, tenant_id: str
) -> None:
    if context.last_turn_id is None:
        raise AssertionError("No turn is active in this scenario.")
    watcher = SseWatcher(context.api_client, context.last_turn_id, tenant_id)
    watcher.start()
    watcher.wait_for_events(1, timeout=2.0)
    context.sse_watcher = watcher


@then("the web UI receives the chunks in order before completion")
def then_web_ui_receives_chunks_in_order(context: object) -> None:
    context.sse_watcher.wait_for_events(3, timeout=2.0)
    tokens = [
        event["token"]
        for event in context.sse_watcher.events
        if event.get("kind") == "turn.token"
    ]
    assert tokens == ["Hel", "lo"]
    turn = context.plane.turn(context.last_channel.tenant_id, context.last_turn_id)
    assert turn.status == TurnStatus.ACTIVE
