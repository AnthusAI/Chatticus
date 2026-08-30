"""Step definitions for channels, messages, and turn-scoped server-sent events."""

from __future__ import annotations

from behave import given, then, when
from sse_helpers import (
    SseWatcher,
    read_sse_until,
    tenant_headers,
)

from chatticus.http.client import HttpTurnClient
from chatticus.models import (
    ActorKind,
    ChannelTenantMismatchError,
    TurnAccessDeniedError,
    TurnStatus,
)
from chatticus.worker.computerless import ComputerlessWorker


def _channel(context: object) -> object:
    if context.last_channel is None:
        raise AssertionError("No channel is open in this scenario.")
    return context.last_channel


def _bot_ids(context: object, table: object) -> list[str]:
    names = [table.headings[0].strip()] if table.headings else []
    names.extend(row.cells[0].strip() for row in table)
    names = [name for name in names if name]
    return [context.bots_by_name[name].bot_id for name in names]


def _capabilities_from_table(table: object) -> frozenset[str]:
    names: list[str] = []
    if table.headings and table.headings[0].strip():
        names.append(table.headings[0].strip())
    names.extend(row.cells[0].strip() for row in table)
    return frozenset(name for name in names if name)


def _turn_id(context: object) -> str:
    if context.last_turn_id is None:
        raise AssertionError("No turn is active in this scenario.")
    return context.last_turn_id


def _load_channel(context: object, tenant_id: str, channel_id: str) -> object:
    context.last_channel = context.plane.channel(tenant_id, channel_id)
    return context.last_channel


def _list_messages_http(context: object, channel: object) -> list[object]:
    response = context.api_client.get(
        f"/channels/{channel.channel_id}/messages",
        headers=tenant_headers(channel.tenant_id),
    )
    assert response.status_code == 200
    payloads = response.json()["messages"]
    return [
        context.plane.list_channel_messages(channel.channel_id, channel.tenant_id)[
            index
        ]
        for index in range(len(payloads))
    ]


def _message_at_seq(context: object, seq: int) -> object:
    channel = _channel(context)
    messages = context.plane.list_channel_messages(
        channel.channel_id, channel.tenant_id
    )
    for message in messages:
        if message.seq == seq:
            return message
    raise AssertionError(f"No message with seq {seq}.")


def _post_chunk_http(
    context: object,
    turn_id: str,
    tenant_id: str,
    token: str,
    *,
    complete: bool = False,
) -> None:
    response = context.api_client.post(
        f"/turns/{turn_id}/chunks",
        json={"token": token, "complete": complete},
        headers=tenant_headers(tenant_id),
    )
    assert response.status_code == 200


@when('tenant "{tenant_id}" user "{user_id}" opens a channel with bots:')
def when_open_channel(context: object, tenant_id: str, user_id: str) -> None:
    bot_ids = _bot_ids(context, context.table)
    response = context.api_client.post(
        "/channels",
        json={"user_id": user_id, "bot_ids": bot_ids},
        headers=tenant_headers(tenant_id),
    )
    assert response.status_code == 200
    _load_channel(context, tenant_id, response.json()["channel_id"])


@given('tenant "{tenant_id}" user "{user_id}" has opened a channel with bots:')
def given_open_channel(context: object, tenant_id: str, user_id: str) -> None:
    when_open_channel(context, tenant_id, user_id)


@given('tenant "{tenant_id}" user "{user_id}" has a channel with a named bot "{name}"')
def given_channel_with_named_bot(
    context: object, tenant_id: str, user_id: str, name: str
) -> None:
    if name not in context.bots_by_name:
        context.bots_by_name[name] = context.plane.create_bot(tenant_id, user_id, name)
    bot = context.bots_by_name[name]
    response = context.api_client.post(
        "/channels",
        json={"user_id": user_id, "bot_ids": [bot.bot_id]},
        headers=tenant_headers(tenant_id),
    )
    assert response.status_code == 200
    _load_channel(context, tenant_id, response.json()["channel_id"])


@when(
    'user "{user_id}" of tenant "{tenant_id}" posts "{body}" '
    'addressed to bot "{name}" on the channel'
)
def when_human_posts_on_channel(
    context: object,
    user_id: str,
    tenant_id: str,
    body: str,
    name: str,
) -> None:
    channel = _channel(context)
    bot = context.bots_by_name[name]
    response = context.api_client.post(
        f"/channels/{channel.channel_id}/messages",
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": user_id,
            "body": body,
            "addressed_to_bot_id": bot.bot_id,
        },
        headers=tenant_headers(tenant_id),
    )
    if response.status_code == 403:
        context.message_error = ChannelTenantMismatchError(response.json()["detail"])
        return
    assert response.status_code == 200
    context.message_error = None
    payload = response.json()
    context.last_turn_id = payload.get("turn_id")


@when('bot "{name}" posts "{body}" addressed to bot "{addressee}" on the channel')
def when_bot_posts_on_channel(
    context: object, name: str, body: str, addressee: str
) -> None:
    channel = _channel(context)
    author = context.bots_by_name[name]
    addressee_bot = context.bots_by_name[addressee]
    response = context.api_client.post(
        f"/channels/{channel.channel_id}/messages",
        json={
            "author_kind": ActorKind.BOT,
            "author_id": author.bot_id,
            "body": body,
            "addressed_to_bot_id": addressee_bot.bot_id,
        },
        headers=tenant_headers(channel.tenant_id),
    )
    assert response.status_code == 200
    context.last_turn_id = response.json().get("turn_id")


@when('tenant "{tenant_id}" posts "{body}" on the channel')
def when_other_tenant_posts_on_channel(
    context: object, tenant_id: str, body: str
) -> None:
    channel = _channel(context)
    response = context.api_client.post(
        f"/channels/{channel.channel_id}/messages",
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "intruder",
            "body": body,
        },
        headers=tenant_headers(tenant_id),
    )
    if response.status_code == 403:
        context.message_error = ChannelTenantMismatchError(response.json()["detail"])
    else:
        context.message_error = None


@then("the channel has {count:d} message")
def then_channel_message_count_one(context: object, count: int) -> None:
    then_channel_message_count(context, count)


@then("the channel has {count:d} messages")
def then_channel_message_count(context: object, count: int) -> None:
    channel = _channel(context)
    response = context.api_client.get(
        f"/channels/{channel.channel_id}/messages",
        headers=tenant_headers(channel.tenant_id),
    )
    assert response.status_code == 200
    assert len(response.json()["messages"]) == count


@then('the message with seq {seq:d} has body "{body}"')
def then_message_body(context: object, seq: int, body: str) -> None:
    message = _message_at_seq(context, seq)
    assert message.body == body


@then('the message with seq {seq:d} is from the human "{user_id}"')
def then_message_from_human(context: object, seq: int, user_id: str) -> None:
    message = _message_at_seq(context, seq)
    assert message.author_kind == ActorKind.HUMAN
    assert message.author_id == user_id


@then('the message with seq {seq:d} is from bot "{name}"')
def then_message_from_bot(context: object, seq: int, name: str) -> None:
    message = _message_at_seq(context, seq)
    bot = context.bots_by_name[name]
    assert message.author_kind == ActorKind.BOT
    assert message.author_id == bot.bot_id


@then("the human can read both messages on the channel")
def then_human_reads_channel(context: object) -> None:
    channel = _channel(context)
    response = context.api_client.get(
        f"/channels/{channel.channel_id}/messages",
        headers=tenant_headers(channel.tenant_id),
    )
    assert response.status_code == 200
    assert len(response.json()["messages"]) == 2


@then('bot "{name}" has {count:d} pending turn with required capabilities:')
def then_bot_pending_turn_with_capabilities(
    context: object, name: str, count: int
) -> None:
    bot = context.bots_by_name[name]
    jobs = context.plane.pending_jobs_for_bot(bot.bot_id)
    assert len(jobs) == count
    expected = _capabilities_from_table(context.table)
    assert jobs[0].required_capabilities == expected


@then("posting fails because the tenant does not match")
def then_post_tenant_mismatch(context: object) -> None:
    assert isinstance(context.message_error, ChannelTenantMismatchError)


@given('tenant "{tenant_id}" user "{user_id}" household computer is stopped')
def given_household_computer_stopped(
    context: object, tenant_id: str, user_id: str
) -> None:
    context.plane.set_computer_stopped(tenant_id, user_id, True)


@when(
    'user "{user_id}" of tenant "{tenant_id}" posts a text-only message '
    'addressed to bot "{name}" on the channel'
)
def when_text_only_post_on_channel(
    context: object, user_id: str, tenant_id: str, name: str
) -> None:
    when_human_posts_on_channel(context, user_id, tenant_id, "what time is it?", name)


@then('bot "{name}" completes one turn')
def then_bot_completes_one_turn(context: object, name: str) -> None:
    channel = _channel(context)
    bot = context.bots_by_name[name]
    turn_client = HttpTurnClient(context.api_client, channel.tenant_id)
    worker = ComputerlessWorker(context.plane, turn_client)
    worker.complete_pending_for_bot(bot.bot_id)


@then("the channel contains one durable bot answer")
def then_channel_has_durable_bot_answer(context: object) -> None:
    channel = _channel(context)
    response = context.api_client.get(
        f"/channels/{channel.channel_id}/messages",
        headers=tenant_headers(channel.tenant_id),
    )
    assert response.status_code == 200
    bot_messages = [
        message
        for message in response.json()["messages"]
        if message["author_kind"] == ActorKind.BOT
    ]
    assert len(bot_messages) == 1


@then('tenant "{tenant_id}" user "{user_id}" household computer remains stopped')
def then_household_computer_remains_stopped(
    context: object, tenant_id: str, user_id: str
) -> None:
    assert context.plane.computer_is_stopped(tenant_id, user_id)


@given('another tenant "{tenant_id}" knows the channel identifier')
def given_other_tenant_knows_channel(context: object, tenant_id: str) -> None:
    _channel(context)
    context.other_tenant_id = tenant_id


@when('tenant "{tenant_id}" tries to post or read on the channel')
def when_other_tenant_post_or_read(context: object, tenant_id: str) -> None:
    channel = _channel(context)
    context.access_error = None
    response = context.api_client.post(
        f"/channels/{channel.channel_id}/messages",
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "intruder",
            "body": "intrusion",
        },
        headers=tenant_headers(tenant_id),
    )
    if response.status_code == 403:
        context.access_error = ChannelTenantMismatchError(response.json()["detail"])
        return
    read_response = context.api_client.get(
        f"/channels/{channel.channel_id}/messages",
        headers=tenant_headers(tenant_id),
    )
    if read_response.status_code == 403:
        context.access_error = ChannelTenantMismatchError(
            read_response.json()["detail"]
        )


@then("access is denied")
def then_access_denied(context: object) -> None:
    assert isinstance(context.access_error, ChannelTenantMismatchError)


@then("the channel is unchanged")
def then_channel_unchanged(context: object) -> None:
    channel = _channel(context)
    response = context.api_client.get(
        f"/channels/{channel.channel_id}/messages",
        headers=tenant_headers(channel.tenant_id),
    )
    assert response.status_code == 200
    assert response.json()["messages"] == []


@given('bot "{name}" is producing an answer for a turn on the channel')
def given_bot_producing_turn(context: object, name: str) -> None:
    channel = _channel(context)
    bot = context.bots_by_name[name]
    response = context.api_client.post(
        f"/channels/{channel.channel_id}/messages",
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": channel.user_id,
            "body": "hello",
            "addressed_to_bot_id": bot.bot_id,
        },
        headers=tenant_headers(channel.tenant_id),
    )
    assert response.status_code == 200
    context.last_turn_id = response.json()["turn_id"]


@given(
    'user "{user_id}" of tenant "{tenant_id}" is watching that turn '
    "through server-sent events"
)
def given_watching_turn_sse(context: object, user_id: str, tenant_id: str) -> None:
    watcher = SseWatcher(context.api_client, _turn_id(context), tenant_id)
    watcher.start()
    watcher.wait_for_events(1, timeout=2.0)
    context.sse_watcher = watcher


@when("the worker posts several coalesced progress chunks for the turn")
def when_worker_posts_chunks(context: object) -> None:
    channel = _channel(context)
    _post_chunk_http(context, _turn_id(context), channel.tenant_id, "Hel")
    _post_chunk_http(context, _turn_id(context), channel.tenant_id, "lo")


@then('user "{user_id}" receives the chunks in order before completion')
def then_receives_chunks_in_order(context: object, user_id: str) -> None:
    context.sse_watcher.wait_for_events(3, timeout=2.0)
    tokens = [
        event["token"]
        for event in context.sse_watcher.events
        if event.get("kind") == "turn.token"
    ]
    assert tokens == ["Hel", "lo"]
    turn = context.plane.turn(_channel(context).tenant_id, _turn_id(context))
    assert turn.status == TurnStatus.ACTIVE


@then('user "{user_id}" receives one terminal server-sent event')
def then_receives_terminal_event(context: object, user_id: str) -> None:
    channel = _channel(context)
    _post_chunk_http(
        context,
        _turn_id(context),
        channel.tenant_id,
        "",
        complete=True,
    )
    context.sse_watcher.wait_for_kind("turn.completed", timeout=5.0)
    terminal = [
        event
        for event in context.sse_watcher.events
        if event.get("kind") == "turn.completed"
    ]
    assert len(terminal) == 1


@then("the turn stream ends")
def then_turn_stream_ends(context: object) -> None:
    assert context.sse_watcher.closed


@then("no connection remains open for the channel or chat tab")
def then_no_persistent_connection(context: object) -> None:
    assert context.app_state.open_sse_streams == 0


@given("a turn has emitted committed events through sequence {seq:d}")
def given_turn_events_through_seq(context: object, seq: int) -> None:
    channel = _channel(context)
    bot = context.bots_by_name["Researcher"]
    response = context.api_client.post(
        f"/channels/{channel.channel_id}/messages",
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": channel.user_id,
            "body": "hello",
            "addressed_to_bot_id": bot.bot_id,
        },
        headers=tenant_headers(channel.tenant_id),
    )
    assert response.status_code == 200
    context.last_turn_id = response.json()["turn_id"]
    tenant_id = channel.tenant_id
    turn_id = _turn_id(context)
    _post_chunk_http(context, turn_id, tenant_id, "Hel")
    _post_chunk_http(context, turn_id, tenant_id, "lo")
    _post_chunk_http(context, turn_id, tenant_id, "!")
    events = read_sse_until(
        context.api_client,
        turn_id,
        tenant_id,
        min_events=4,
        timeout=2.0,
    )
    assert len(events) >= 4
    watcher = SseWatcher(context.api_client, turn_id, tenant_id)
    watcher.events = list(events)
    watcher.closed = True
    context.sse_watcher = watcher


@given("the watching connection for that turn closes")
def given_watching_connection_closes(context: object) -> None:
    if context.sse_watcher is not None:
        context.sse_watcher.stop()
    context.sse_watcher = None


@when(
    'user "{user_id}" of tenant "{tenant_id}" reconnects to the turn '
    "after sequence {seq:d}"
)
def when_reconnect_after_seq(
    context: object, user_id: str, tenant_id: str, seq: int
) -> None:
    watcher = SseWatcher(
        context.api_client, _turn_id(context), tenant_id, after_seq=seq
    )
    watcher.start()
    watcher.wait_for_events(2, timeout=2.0)
    context.sse_watcher = watcher


@then("committed events 3 and 4 are replayed once in order")
def then_events_replayed_in_order(context: object) -> None:
    replayed = [event for event in context.sse_watcher.events if event["seq"] in (3, 4)]
    assert len(replayed) == 2
    assert replayed[0]["seq"] == 3
    assert replayed[1]["seq"] == 4


@then("later events continue from the same turn")
def then_later_events_continue(context: object) -> None:
    channel = _channel(context)
    _post_chunk_http(
        context,
        _turn_id(context),
        channel.tenant_id,
        "",
        complete=True,
    )
    context.sse_watcher.wait_for_kind("turn.completed", timeout=5.0)
    completed = [
        event
        for event in context.sse_watcher.events
        if event.get("kind") == "turn.completed"
    ]
    assert len(completed) == 1


@then("the turn completes whether or not a watcher remains connected")
def then_turn_completes_without_watcher(context: object) -> None:
    channel = _channel(context)
    turn = context.plane.turn(channel.tenant_id, _turn_id(context))
    assert turn.status == TurnStatus.COMPLETED


@given('user "{user_id}" of tenant "{tenant_id}" has an active turn on the channel')
def given_active_turn_on_channel(context: object, user_id: str, tenant_id: str) -> None:
    given_bot_producing_turn(context, "Researcher")


@when('tenant "{tenant_id}" tries to open the turn stream')
def when_other_opens_turn_stream(context: object, tenant_id: str) -> None:
    response = context.api_client.get(
        f"/turns/{_turn_id(context)}/stream",
        headers=tenant_headers(tenant_id),
    )
    if response.status_code == 403:
        context.stream_error = TurnAccessDeniedError(response.json()["detail"])
    else:
        context.stream_error = None


@then("turn stream access is denied because the tenant does not match")
def then_turn_stream_tenant_denied(context: object) -> None:
    assert isinstance(context.stream_error, TurnAccessDeniedError)
