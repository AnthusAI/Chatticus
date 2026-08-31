"""Step definitions for channels, messages, and turn-scoped server-sent events."""

from __future__ import annotations

from dataclasses import replace
from uuid import uuid4

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
    ComputerlessCannotExecuteComputerJob,
    TurnAccessDeniedError,
    TurnEventKind,
    TurnJob,
    TurnStatus,
)
from chatticus.worker.computerless import (
    ComputerlessWorker,
    CountingTextCompletionClient,
    FakeTextCompletionClient,
)


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


def _claim_http(context: object, turn_id: str, tenant_id: str, worker_id: str) -> int:
    response = context.api_client.post(
        f"/turns/{turn_id}/claim",
        json={"worker_id": worker_id},
        headers=tenant_headers(tenant_id),
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    context.fence_token = int(payload["fence_token"])
    context.claim_acquired = payload["acquired"]
    return context.fence_token


def _post_chunk_http(
    context: object,
    turn_id: str,
    tenant_id: str,
    token: str,
    *,
    complete: bool = False,
    fence_token: int | None = None,
    expect_ok: bool = True,
) -> int:
    resolved_fence = fence_token if fence_token is not None else context.fence_token
    response = context.api_client.post(
        f"/turns/{turn_id}/chunks",
        json={
            "token": token,
            "complete": complete,
            "fence_token": resolved_fence,
        },
        headers=tenant_headers(tenant_id),
    )
    if expect_ok:
        assert response.status_code == 200, response.text
    return response.status_code


@when('tenant "{tenant_id}" user "{user_id}" opens a channel with bots:')
def when_open_channel(context: object, tenant_id: str, user_id: str) -> None:
    bot_ids = _bot_ids(context, context.table)
    response = context.api_client.post(
        "/channels",
        json={"user_id": user_id, "bot_ids": bot_ids},
        headers=tenant_headers(tenant_id),
    )
    assert response.status_code == 200
    channel_id = response.json()["channel_id"]
    opened = getattr(context, "opened_channel_ids", None)
    if opened is None:
        context.opened_channel_ids = [channel_id]
    else:
        opened.append(channel_id)
    _load_channel(context, tenant_id, channel_id)


@when(
    'tenant "{tenant_id}" user "{user_id}" opens a channel with '
    'idempotency key "{key}" with bots:'
)
def when_open_channel_with_idempotency(
    context: object, tenant_id: str, user_id: str, key: str
) -> None:
    bot_ids = _bot_ids(context, context.table)
    previous = getattr(context, "idempotent_channel_id", None)
    response = context.api_client.post(
        "/channels",
        json={"user_id": user_id, "bot_ids": bot_ids},
        headers={**tenant_headers(tenant_id), "Idempotency-Key": key},
    )
    assert response.status_code == 200
    channel_id = response.json()["channel_id"]
    if previous is None:
        context.idempotent_channel_id = channel_id
    else:
        context.repeated_channel_id = channel_id
    _load_channel(context, tenant_id, channel_id)


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


@when(
    'user "{user_id}" of tenant "{tenant_id}" posts "{body}" '
    'addressed to bot "{name}" on the channel with idempotency key "{key}"'
)
def when_human_posts_on_channel_with_idempotency_key(
    context: object,
    user_id: str,
    tenant_id: str,
    body: str,
    name: str,
    key: str,
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
        headers={**tenant_headers(tenant_id), "Idempotency-Key": key},
    )
    assert response.status_code == 200
    context.message_error = None
    payload = response.json()
    context.last_turn_id = payload.get("turn_id")
    context.last_message_id = payload["message"]["message_id"]


@when(
    'user "{user_id}" of tenant "{tenant_id}" posts a fence probe '
    'addressed to bot "{name}" without enqueueing a turn job'
)
def when_human_posts_fence_probe_without_enqueue(
    context: object,
    user_id: str,
    tenant_id: str,
    name: str,
) -> None:
    channel = _channel(context)
    bot = context.bots_by_name[name]
    response = context.api_client.post(
        f"/channels/{channel.channel_id}/messages",
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": user_id,
            "body": "Fence probe; do not wait on this turn.",
            "addressed_to_bot_id": bot.bot_id,
            "enqueue_turn": False,
        },
        headers=tenant_headers(tenant_id),
    )
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


@then("the opened channel identifier is unchanged")
def then_opened_channel_identifier_is_unchanged(context: object) -> None:
    first = getattr(context, "idempotent_channel_id", None)
    second = getattr(context, "repeated_channel_id", None)
    assert first is not None
    assert second == first


@then('tenant "{tenant_id}" can read the open channel by identifier')
def then_tenant_reads_open_channel(context: object, tenant_id: str) -> None:
    channel = _channel(context)
    response = context.api_client.get(
        f"/channels/{channel.channel_id}",
        headers=tenant_headers(tenant_id),
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["channel_id"] == channel.channel_id
    assert payload["tenant_id"] == tenant_id
    assert payload["user_id"] == channel.user_id
    participant_ids = {item["actor_id"] for item in payload["participants"]}
    expected_ids = {participant.actor_id for participant in channel.participants}
    assert participant_ids == expected_ids


@then('tenant "{tenant_id}" can list channels for user "{user_id}":')
def then_list_user_channels(context: object, tenant_id: str, user_id: str) -> None:
    opened_ids: list[str] = getattr(context, "opened_channel_ids", [])

    def resolve_cell(cell: str) -> str:
        value = cell.strip()
        if value.isdigit():
            return opened_ids[int(value) - 1]
        return value

    expected_ids: list[str] = []
    if context.table.headings and context.table.headings[0].strip():
        expected_ids.append(resolve_cell(context.table.headings[0]))
    expected_ids.extend(resolve_cell(row.cells[0]) for row in context.table)
    expected_ids = [channel_id for channel_id in expected_ids if channel_id]
    response = context.api_client.get(
        f"/users/{user_id}/channels",
        headers=tenant_headers(tenant_id),
    )
    assert response.status_code == 200
    listed_ids = [channel["channel_id"] for channel in response.json()["channels"]]
    assert listed_ids == sorted(expected_ids)
    for channel_id in expected_ids:
        payload = next(
            channel
            for channel in response.json()["channels"]
            if channel["channel_id"] == channel_id
        )
        assert payload["tenant_id"] == tenant_id
        assert payload["user_id"] == user_id


@then('tenant "{tenant_id}" can read the household computer for user "{user_id}"')
def then_read_household_computer(context: object, tenant_id: str, user_id: str) -> None:
    expected_id = context.household_computer_ids[(tenant_id, user_id)]
    response = context.api_client.get(
        f"/users/{user_id}/computer",
        headers=tenant_headers(tenant_id),
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["computer_id"] == expected_id
    assert payload["tenant_id"] == tenant_id
    assert payload["user_id"] == user_id
    assert payload["stopped"] is True
    missing = context.api_client.get(
        f"/users/{user_id}/computer",
        headers=tenant_headers("other"),
    )
    assert missing.status_code == 404


@then('tenant "{tenant_id}" can read the active turn on the open channel')
def then_read_active_channel_turn(context: object, tenant_id: str) -> None:
    channel = _channel(context)
    expected_turn_id = _turn_id(context)
    response = context.api_client.get(
        f"/channels/{channel.channel_id}/turn",
        headers=tenant_headers(tenant_id),
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["turn_id"] == expected_turn_id
    assert payload["channel_id"] == channel.channel_id
    assert payload["status"] == "active"


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


@when(
    'user "{user_id}" of tenant "{tenant_id}" lists channel messages after seq {seq:d}'
)
def when_list_channel_messages_after_seq(
    context: object, user_id: str, tenant_id: str, seq: int
) -> None:
    channel = _channel(context)
    response = context.api_client.get(
        f"/channels/{channel.channel_id}/messages",
        params={"after": seq},
        headers=tenant_headers(tenant_id),
    )
    assert response.status_code == 200
    context.listed_messages = response.json()["messages"]


@then("the listing contains only the message with seq {seq:d}")
def then_listing_contains_only_seq(context: object, seq: int) -> None:
    listed = context.listed_messages
    assert listed is not None
    assert [item["seq"] for item in listed] == [seq]


@then('bot "{name}" has {count:d} pending turn with required capabilities:')
def then_bot_pending_turn_with_capabilities(
    context: object, name: str, count: int
) -> None:
    bot = context.bots_by_name[name]
    jobs = context.plane.pending_jobs_for_bot(bot.bot_id)
    assert len(jobs) == count
    expected = _capabilities_from_table(context.table)
    assert jobs[0].required_capabilities == expected


@then("the channel has a turn")
def then_channel_has_a_turn(context: object) -> None:
    channel = _channel(context)
    turn_id = context.last_turn_id
    assert turn_id
    turn = context.plane.turn(channel.tenant_id, turn_id)
    assert turn.channel_id == channel.channel_id
    assert context.plane.job_for_turn(channel.tenant_id, turn_id) is None


@then('bot "{name}" has 0 pending turns')
def then_bot_has_zero_pending_turns(context: object, name: str) -> None:
    bot = context.bots_by_name[name]
    assert context.plane.pending_jobs_for_bot(bot.bot_id) == []


@then("the cpu enqueue hook was not invoked")
def then_cpu_enqueue_hook_was_never_invoked(context: object) -> None:
    assert getattr(context, "cpu_enqueued_jobs", None) == []


@then("posting fails because the tenant does not match")
def then_post_tenant_mismatch(context: object) -> None:
    assert isinstance(context.message_error, ChannelTenantMismatchError)


@given('tenant "{tenant_id}" user "{user_id}" household computer is stopped')
def given_household_computer_stopped(
    context: object, tenant_id: str, user_id: str
) -> None:
    context.plane.set_computer_stopped(tenant_id, user_id, True)
    computers = getattr(context, "household_computer_ids", None)
    if computers is None:
        computers = {}
        context.household_computer_ids = computers
    computers[(tenant_id, user_id)] = context.plane.computer_for_user(
        tenant_id, user_id
    ).computer_id


@given('tenant "{tenant_id}" user "{user_id}" household computer is running')
@when('tenant "{tenant_id}" user "{user_id}" household computer is running')
def household_computer_running(context: object, tenant_id: str, user_id: str) -> None:
    context.plane.set_computer_stopped(tenant_id, user_id, False)


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
    worker = ComputerlessWorker(context.plane, turn_client, FakeTextCompletionClient())
    worker.complete_pending_for_bot(bot.bot_id)


@when('bot "{name}" runs one computerless worker turn')
def when_bot_runs_computerless_worker(context: object, name: str) -> None:
    then_bot_completes_one_turn(context, name)


@when('a counting computerless worker processes bot "{name}"')
def when_counting_computerless_worker_processes(context: object, name: str) -> None:
    channel = _channel(context)
    bot = context.bots_by_name[name]
    context.counting_client = CountingTextCompletionClient()
    worker = ComputerlessWorker(
        context.plane,
        HttpTurnClient(context.api_client, channel.tenant_id),
        context.counting_client,
    )
    worker.complete_pending_for_bot(bot.bot_id)
    turn = context.plane.turn(channel.tenant_id, _turn_id(context))
    context.waiting_action_id = turn.pending_computer_action_id


@when("the same waiting turn is delivered to a computerless worker again")
def when_waiting_turn_redelivered_to_computerless(context: object) -> None:
    channel = _channel(context)
    turn_id = _turn_id(context)
    turn = context.plane.turn(channel.tenant_id, turn_id)
    job = TurnJob(
        job_id=str(uuid4()),
        tenant_id=channel.tenant_id,
        required_capabilities=frozenset({"cpu"}),
        user_id=channel.user_id,
        bot_id=turn.bot_id,
        turn_id=turn_id,
    )
    ComputerlessWorker(
        context.plane,
        HttpTurnClient(context.api_client, channel.tenant_id),
        context.counting_client,
    ).run_job(job)


@then("the pending computer tool action identifier is unchanged")
def then_pending_tool_action_id_unchanged(context: object) -> None:
    channel = _channel(context)
    turn = context.plane.turn(channel.tenant_id, _turn_id(context))
    assert turn.pending_computer_action_id == context.waiting_action_id
    assert turn.pending_computer_action_id


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
    channel_response = context.api_client.get(
        f"/channels/{channel.channel_id}",
        headers=tenant_headers(tenant_id),
    )
    if channel_response.status_code == 403:
        context.access_error = ChannelTenantMismatchError(
            channel_response.json()["detail"]
        )
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
    _claim_http(context, context.last_turn_id, channel.tenant_id, "sse-worker")


@given(
    'user "{user_id}" of tenant "{tenant_id}" is watching that turn '
    "through server-sent events"
)
@when(
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
    _claim_http(context, turn_id, tenant_id, "sse-worker")
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


@when('user "{user_id}" of tenant "{tenant_id}" lists turn events after seq {seq:d}')
def when_list_turn_events_after_seq(
    context: object, user_id: str, tenant_id: str, seq: int
) -> None:
    response = context.api_client.get(
        f"/turns/{_turn_id(context)}/events",
        params={"after": seq},
        headers=tenant_headers(tenant_id),
    )
    assert response.status_code == 200
    context.listed_turn_events = response.json()["events"]


@then("the turn listing contains only events {start:d} and {end:d} in order")
def then_turn_listing_contains_only_events(
    context: object, start: int, end: int
) -> None:
    listed = context.listed_turn_events
    assert listed is not None
    assert [event["seq"] for event in listed] == [start, end]


@when(
    'user "{user_id}" of tenant "{tenant_id}" reconnects to the turn '
    "with Last-Event-ID {seq:d}"
)
def when_reconnect_with_last_event_id(
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


@when("the worker posts a progress chunk and then waits on the browser gate")
def when_worker_posts_chunk_then_waiting(context: object) -> None:
    channel = _channel(context)
    turn_id = _turn_id(context)
    tenant_id = channel.tenant_id
    _post_chunk_http(context, turn_id, tenant_id, "Here is a draft.")
    client = HttpTurnClient(
        context.api_client, tenant_id, fence_token=context.fence_token
    )
    client.post_waiting(turn_id, "browser")


@then('user "{user_id}" receives a waiting server-sent event naming {gate}')
def then_receives_waiting_event(context: object, user_id: str, gate: str) -> None:
    context.sse_watcher.wait_for_kind("turn.waiting", timeout=5.0)
    waiting = [
        event
        for event in context.sse_watcher.events
        if event.get("kind") == "turn.waiting"
    ]
    assert waiting
    assert waiting[0].get("body") == gate


@then("the turn remains active")
def then_turn_remains_active(context: object) -> None:
    channel = _channel(context)
    turn = context.plane.turn(channel.tenant_id, _turn_id(context))
    assert turn.status == TurnStatus.ACTIVE
    assert turn.claimed_by_worker_id is None


@then("the turn is still waiting on the browser gate")
def then_turn_still_waiting_on_browser(context: object) -> None:
    channel = _channel(context)
    turn = context.plane.turn(channel.tenant_id, _turn_id(context))
    assert turn.waiting_for == "browser"


@then('user "{user_id}" can read the turn gate as {gate} without opening SSE')
def then_user_reads_turn_gate_without_sse(
    context: object, user_id: str, gate: str
) -> None:
    del user_id
    channel = _channel(context)
    response = context.api_client.get(
        f"/turns/{_turn_id(context)}",
        headers=tenant_headers(channel.tenant_id),
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "active"
    assert payload["waiting_for"] == gate


@then('user "{user_id}" can read the pending computer tool {tool_name} for {gate}')
def then_user_reads_pending_computer_tool(
    context: object, user_id: str, tool_name: str, gate: str
) -> None:
    del user_id
    channel = _channel(context)
    response = context.api_client.get(
        f"/turns/{_turn_id(context)}",
        headers=tenant_headers(channel.tenant_id),
    )
    assert response.status_code == 200
    pending = response.json().get("pending_computer_tool")
    assert pending is not None
    assert pending["tool_name"] == tool_name
    assert pending["arguments"] == {"gate": gate}
    assert pending["action_id"]


@then("the waiting journal event names {tool_name} for {gate}")
def then_waiting_journal_names_tool(context: object, tool_name: str, gate: str) -> None:
    channel = _channel(context)
    turn_id = _turn_id(context)
    events = context.plane.list_turn_events(channel.tenant_id, turn_id)
    waiting = [event for event in events if event.kind == TurnEventKind.TURN_WAITING]
    assert len(waiting) == 1
    pending = waiting[0].pending_computer_tool
    assert pending is not None
    assert pending.tool_name == tool_name
    assert pending.arguments == {"gate": gate}
    assert pending.action_id
    sse_waiting = [
        event
        for event in context.sse_watcher.events
        if event.get("kind") == TurnEventKind.TURN_WAITING
    ]
    assert sse_waiting
    sse_pending = sse_waiting[0].get("pending_computer_tool")
    assert sse_pending is not None
    assert sse_pending["tool_name"] == tool_name
    assert sse_pending["arguments"] == {"gate": gate}
    assert sse_pending["action_id"] == pending.action_id


@then('user "{user_id}" reads the same action identifier from GET and the journal')
def then_action_id_stable_across_get_and_journal(context: object, user_id: str) -> None:
    del user_id
    channel = _channel(context)
    turn_id = _turn_id(context)
    headers = tenant_headers(channel.tenant_id)
    first = context.api_client.get(f"/turns/{turn_id}", headers=headers).json()
    second = context.api_client.get(f"/turns/{turn_id}", headers=headers).json()
    get_action_id = first["pending_computer_tool"]["action_id"]
    assert get_action_id
    assert second["pending_computer_tool"]["action_id"] == get_action_id
    events = context.plane.list_turn_events(channel.tenant_id, turn_id)
    waiting = [event for event in events if event.kind == TurnEventKind.TURN_WAITING]
    assert waiting[0].pending_computer_tool is not None
    assert waiting[0].pending_computer_tool.action_id == get_action_id


@when('user "{user_id}" of tenant "{tenant_id}" tries to resume that waiting turn')
def when_user_tries_to_resume_waiting_turn(
    context: object, user_id: str, tenant_id: str
) -> None:
    del user_id
    response = context.api_client.post(
        f"/turns/{_turn_id(context)}/resume",
        headers=tenant_headers(tenant_id),
    )
    context.resume_response = response


@when('user "{user_id}" of tenant "{tenant_id}" resumes that waiting turn')
def when_user_resumes_waiting_turn(
    context: object, user_id: str, tenant_id: str
) -> None:
    del user_id
    response = context.api_client.post(
        f"/turns/{_turn_id(context)}/resume",
        headers=tenant_headers(tenant_id),
    )
    assert response.status_code == 200
    context.resume_response = response


@when("a computerless worker is given the continuation job")
def when_computerless_given_continuation_job(context: object) -> None:
    channel = _channel(context)
    job = context.plane.job_for_turn(channel.tenant_id, _turn_id(context))
    assert job is not None
    context.continuation_job = job
    context.continuation_error = None
    try:
        ComputerlessWorker(
            context.plane,
            HttpTurnClient(context.api_client, channel.tenant_id),
            context.counting_client,
        ).run_job(job)
    except ComputerlessCannotExecuteComputerJob as exc:
        context.continuation_error = exc


@then("the computerless worker refuses the computer job")
def then_computerless_refuses_computer_job(context: object) -> None:
    assert isinstance(context.continuation_error, ComputerlessCannotExecuteComputerJob)


@then("the continuation job remains queued")
def then_continuation_job_remains_queued(context: object) -> None:
    channel = _channel(context)
    job = context.plane.job_for_turn(channel.tenant_id, _turn_id(context))
    assert job is not None
    assert job.job_id == context.continuation_job.job_id
    assert "computer" in job.required_capabilities


@then("the resume response requires computer")
def then_resume_response_requires_computer(context: object) -> None:
    payload = context.resume_response.json()
    assert payload.get("required_capabilities") == ["computer"]


@then("the continuation job requires computer")
def then_continuation_job_requires_computer(context: object) -> None:
    channel = _channel(context)
    job = context.plane.job_for_turn(channel.tenant_id, _turn_id(context))
    assert job is not None
    assert "computer" in job.required_capabilities
    context.continuation_job = job


@then("the cpu enqueue hook was not invoked for that job")
def then_cpu_enqueue_hook_skipped_continuation(context: object) -> None:
    job = context.continuation_job
    captured_ids = [item.job_id for item in context.cpu_enqueued_jobs]
    assert captured_ids, "cpu enqueue hook never ran for the original text job"
    assert job.job_id not in captured_ids
    assert "computer" not in context.cpu_enqueued_jobs[0].required_capabilities


@then("the computer enqueue hook received that job")
def then_computer_enqueue_hook_received_continuation(context: object) -> None:
    job = context.continuation_job
    captured_ids = [item.job_id for item in context.computer_enqueued_jobs]
    assert captured_ids == [job.job_id]
    assert "computer" in context.computer_enqueued_jobs[0].required_capabilities


@then("resume is refused because the computer is not ready")
def then_resume_refused_computer_not_ready(context: object) -> None:
    assert context.resume_response.status_code == 409
    detail = context.resume_response.json()["detail"]
    assert "still stopped" in detail


@given("one unfinished turn job is delivered twice")
def given_unfinished_job_delivered_twice(context: object) -> None:
    channel = _channel(context)
    bot = context.bots_by_name["Assistant"]
    when_human_posts_on_channel(
        context, channel.user_id, channel.tenant_id, "ping", "Assistant"
    )
    jobs = context.plane.pending_jobs_for_bot(bot.bot_id)
    assert len(jobs) == 1
    first = jobs[0]
    second = replace(first, job_id=str(uuid4()))
    context.duplicate_jobs = [first, second]
    context.counting_client = CountingTextCompletionClient()


@when("two workers try to process it concurrently")
def when_two_workers_process_turn(context: object) -> None:
    channel = _channel(context)
    for job in context.duplicate_jobs:
        worker = ComputerlessWorker(
            context.plane,
            HttpTurnClient(context.api_client, channel.tenant_id),
            context.counting_client,
        )
        worker.run_job(job)


@then("only one worker begins the model attempt")
def then_one_model_attempt(context: object) -> None:
    assert context.counting_client.calls == 1


@then("only that attempt can append progress or completion")
def then_only_owner_appends(context: object) -> None:
    channel = _channel(context)
    turn = context.plane.turn(channel.tenant_id, _turn_id(context))
    stale = _post_chunk_http(
        context,
        turn.turn_id,
        channel.tenant_id,
        "extra",
        fence_token=0,
        expect_ok=False,
    )
    assert stale == 409


@then("the channel receives at most one final answer")
def then_at_most_one_answer(context: object) -> None:
    then_channel_has_durable_bot_answer(context)


@given("a turn has been reassigned to a newer attempt")
def given_turn_reassigned(context: object) -> None:
    channel = _channel(context)
    when_human_posts_on_channel(
        context, channel.user_id, channel.tenant_id, "ping", "Assistant"
    )
    turn_id = _turn_id(context)
    _claim_http(context, turn_id, channel.tenant_id, "worker-a")
    context.stale_fence = context.fence_token
    context.plane.advance_seconds(61)
    _claim_http(context, turn_id, channel.tenant_id, "worker-b")
    context.current_fence = context.fence_token


@when("the expired attempt tries to append output or execute an action")
def when_expired_attempt_appends(context: object) -> None:
    channel = _channel(context)
    context.stale_status = _post_chunk_http(
        context,
        _turn_id(context),
        channel.tenant_id,
        "late",
        fence_token=context.stale_fence,
        expect_ok=False,
    )


@then("the operation is rejected")
def then_operation_rejected(context: object) -> None:
    assert context.stale_status == 409


@then("only the newer attempt can change the turn")
def then_newer_attempt_writes(context: object) -> None:
    channel = _channel(context)
    status = _post_chunk_http(
        context,
        _turn_id(context),
        channel.tenant_id,
        "ok",
        complete=True,
        fence_token=context.current_fence,
    )
    assert status == 200


@then("the user sees no duplicate output or action")
def then_no_duplicate_output(context: object) -> None:
    then_channel_has_durable_bot_answer(context)
    messages = context.api_client.get(
        f"/channels/{_channel(context).channel_id}/messages",
        headers=tenant_headers(_channel(context).tenant_id),
    ).json()["messages"]
    bot_bodies = [
        message["body"]
        for message in messages
        if message["author_kind"] == ActorKind.BOT
    ]
    assert bot_bodies == ["ok"]
