"""Step definitions for channels, messages, and turn-scoped server-sent events."""

from __future__ import annotations

from behave import given, then, when

from chatticus.models import (
    ActorKind,
    ChannelTenantMismatchError,
    TurnAccessDeniedError,
    TurnEventKind,
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


def _message_at_seq(context: object, seq: int) -> object:
    channel = _channel(context)
    messages = context.plane.list_channel_messages(
        channel.channel_id, channel.tenant_id
    )
    for message in messages:
        if message.seq == seq:
            return message
    raise AssertionError(f"No message with seq {seq}.")


@when('tenant "{tenant_id}" user "{user_id}" opens a channel with bots:')
def when_open_channel(context: object, tenant_id: str, user_id: str) -> None:
    bot_ids = _bot_ids(context, context.table)
    channel = context.plane.create_channel(tenant_id, user_id, bot_ids)
    context.last_channel = channel


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
    channel = context.plane.create_channel(tenant_id, user_id, [bot.bot_id])
    context.last_channel = channel


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
    try:
        context.last_message = context.plane.post_channel_message(
            channel.channel_id,
            tenant_id,
            ActorKind.HUMAN,
            user_id,
            body,
            addressed_to_bot_id=bot.bot_id,
        )
        context.message_error = None
    except (ChannelTenantMismatchError, Exception) as error:
        context.message_error = error


@when('bot "{name}" posts "{body}" addressed to bot "{addressee}" on the channel')
def when_bot_posts_on_channel(
    context: object, name: str, body: str, addressee: str
) -> None:
    channel = _channel(context)
    author = context.bots_by_name[name]
    addressee_bot = context.bots_by_name[addressee]
    context.plane.post_channel_message(
        channel.channel_id,
        channel.tenant_id,
        ActorKind.BOT,
        author.bot_id,
        body,
        addressed_to_bot_id=addressee_bot.bot_id,
    )


@when('tenant "{tenant_id}" posts "{body}" on the channel')
def when_other_tenant_posts_on_channel(
    context: object, tenant_id: str, body: str
) -> None:
    channel = _channel(context)
    try:
        context.plane.post_channel_message(
            channel.channel_id,
            tenant_id,
            ActorKind.HUMAN,
            "intruder",
            body,
        )
        context.message_error = None
    except (ChannelTenantMismatchError, Exception) as error:
        context.message_error = error


@then("the channel has {count:d} message")
def then_channel_message_count_one(context: object, count: int) -> None:
    then_channel_message_count(context, count)


@then("the channel has {count:d} messages")
def then_channel_message_count(context: object, count: int) -> None:
    channel = _channel(context)
    messages = context.plane.list_channel_messages(
        channel.channel_id, channel.tenant_id
    )
    assert len(messages) == count


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
    messages = context.plane.list_channel_messages(
        channel.channel_id, channel.tenant_id
    )
    assert len(messages) == 2


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
    bot = context.bots_by_name[name]
    worker = ComputerlessWorker(context.plane)
    worker.complete_pending_for_bot(bot.bot_id)


@then("the channel contains one durable bot answer")
def then_channel_has_durable_bot_answer(context: object) -> None:
    channel = _channel(context)
    messages = context.plane.list_channel_messages(
        channel.channel_id, channel.tenant_id
    )
    bot_messages = [
        message for message in messages if message.author_kind == ActorKind.BOT
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
    try:
        context.plane.post_channel_message(
            channel.channel_id,
            tenant_id,
            ActorKind.HUMAN,
            "intruder",
            "intrusion",
        )
    except (ChannelTenantMismatchError, Exception) as error:
        context.access_error = error
        return
    try:
        context.plane.list_channel_messages(channel.channel_id, tenant_id)
    except (ChannelTenantMismatchError, Exception) as error:
        context.access_error = error


@then("access is denied")
def then_access_denied(context: object) -> None:
    assert isinstance(context.access_error, ChannelTenantMismatchError)


@then("the channel is unchanged")
def then_channel_unchanged(context: object) -> None:
    channel = _channel(context)
    messages = context.plane.list_channel_messages(
        channel.channel_id, channel.tenant_id
    )
    assert messages == []


@given('bot "{name}" is producing an answer for a turn on the channel')
def given_bot_producing_turn(context: object, name: str) -> None:
    channel = _channel(context)
    bot = context.bots_by_name[name]
    context.plane.post_channel_message(
        channel.channel_id,
        channel.tenant_id,
        ActorKind.HUMAN,
        channel.user_id,
        "hello",
        addressed_to_bot_id=bot.bot_id,
    )
    jobs = context.plane.pending_jobs_for_bot(bot.bot_id)
    context.last_turn_id = jobs[0].turn_id


@given(
    'user "{user_id}" of tenant "{tenant_id}" is watching that turn '
    "through server-sent events"
)
def given_watching_turn_sse(context: object, user_id: str, tenant_id: str) -> None:
    context.turn_stream = context.plane.open_turn_stream(_turn_id(context), tenant_id)


@when("the worker posts several coalesced progress chunks for the turn")
def when_worker_posts_chunks(context: object) -> None:
    channel = _channel(context)
    context.plane.post_turn_chunk(_turn_id(context), channel.tenant_id, "Hel")
    context.plane.post_turn_chunk(_turn_id(context), channel.tenant_id, "lo")


@then('user "{user_id}" receives the chunks in order before completion')
def then_receives_chunks_in_order(context: object, user_id: str) -> None:
    tokens = [
        event.token
        for event in context.turn_stream.events
        if event.kind == TurnEventKind.TURN_TOKEN
    ]
    assert tokens == ["Hel", "lo"]
    turn = context.plane.turn(_channel(context).tenant_id, _turn_id(context))
    assert turn.status == TurnStatus.ACTIVE


@then('user "{user_id}" receives one terminal server-sent event')
def then_receives_terminal_event(context: object, user_id: str) -> None:
    channel = _channel(context)
    context.plane.complete_turn(channel.tenant_id, _turn_id(context))
    terminal = [
        event
        for event in context.turn_stream.events
        if event.kind == TurnEventKind.TURN_COMPLETED
    ]
    assert len(terminal) == 1


@then("the turn stream ends")
def then_turn_stream_ends(context: object) -> None:
    assert context.turn_stream.closed


@then("no connection remains open for the channel or chat tab")
def then_no_persistent_connection(context: object) -> None:
    open_watchers = [
        watcher
        for watcher in context.plane._turn_watchers.values()
        if not watcher.closed
    ]
    assert open_watchers == []


@given("a turn has emitted committed events through sequence {seq:d}")
def given_turn_events_through_seq(context: object, seq: int) -> None:
    channel = _channel(context)
    bot = context.bots_by_name["Researcher"]
    context.plane.post_channel_message(
        channel.channel_id,
        channel.tenant_id,
        ActorKind.HUMAN,
        channel.user_id,
        "hello",
        addressed_to_bot_id=bot.bot_id,
    )
    jobs = context.plane.pending_jobs_for_bot(bot.bot_id)
    context.last_turn_id = jobs[0].turn_id
    tenant_id = channel.tenant_id
    context.plane.post_turn_chunk(_turn_id(context), tenant_id, "Hel")
    context.plane.post_turn_chunk(_turn_id(context), tenant_id, "lo")
    context.plane.post_turn_chunk(_turn_id(context), tenant_id, "!")
    context.turn_stream = context.plane.open_turn_stream(_turn_id(context), tenant_id)


@given("the watching connection for that turn closes")
def given_watching_connection_closes(context: object) -> None:
    context.plane.close_turn_stream(context.turn_stream.watcher_id)
    context.turn_stream = None


@when(
    'user "{user_id}" of tenant "{tenant_id}" reconnects to the turn '
    "after sequence {seq:d}"
)
def when_reconnect_after_seq(
    context: object, user_id: str, tenant_id: str, seq: int
) -> None:
    context.turn_stream = context.plane.open_turn_stream(
        _turn_id(context), tenant_id, after_seq=seq
    )


@then("committed events 3 and 4 are replayed once in order")
def then_events_replayed_in_order(context: object) -> None:
    replayed = [event for event in context.turn_stream.events if event.seq in (3, 4)]
    assert len(replayed) == 2
    assert replayed[0].seq == 3
    assert replayed[1].seq == 4


@then("later events continue from the same turn")
def then_later_events_continue(context: object) -> None:
    channel = _channel(context)
    context.plane.complete_turn(channel.tenant_id, _turn_id(context))
    completed = [
        event
        for event in context.turn_stream.events
        if event.kind == TurnEventKind.TURN_COMPLETED
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
    try:
        context.plane.open_turn_stream(_turn_id(context), tenant_id)
        context.stream_error = None
    except (TurnAccessDeniedError, Exception) as error:
        context.stream_error = error


@then("turn stream access is denied because the tenant does not match")
def then_turn_stream_tenant_denied(context: object) -> None:
    assert isinstance(context.stream_error, TurnAccessDeniedError)
