"""Step definitions for threads, messages, and the realtime API."""

from __future__ import annotations

from behave import given, then, when

from chatticus.models import (
    ActorKind,
    ThreadTenantMismatchError,
)


def _thread(context: object) -> object:
    assert context.last_thread is not None
    return context.last_thread


def _bot_ids(context: object, table: object) -> list[str]:
    names = [table.headings[0].strip()] if table.headings else []
    names.extend(row.cells[0].strip() for row in table)
    names = [name for name in names if name]
    return [context.bots_by_name[name].bot_id for name in names]


@when('tenant "{tenant_id}" user "{user_id}" opens a thread with bots:')
def when_open_thread(context: object, tenant_id: str, user_id: str) -> None:
    bot_ids = _bot_ids(context, context.table)
    context.last_thread = context.plane.create_thread(tenant_id, user_id, bot_ids)


@given('tenant "{tenant_id}" user "{user_id}" has opened a thread with bots:')
def given_open_thread(context: object, tenant_id: str, user_id: str) -> None:
    when_open_thread(context, tenant_id, user_id)


@when(
    'user "{user_id}" of tenant "{tenant_id}" posts "{body}" addressed to bot "{name}"'
)
def when_human_posts(
    context: object,
    user_id: str,
    tenant_id: str,
    body: str,
    name: str,
) -> None:
    thread = _thread(context)
    bot = context.bots_by_name[name]
    try:
        context.last_message = context.plane.post_message(
            thread.thread_id,
            tenant_id,
            ActorKind.HUMAN,
            user_id,
            body,
            addressed_to_bot_id=bot.bot_id,
        )
        context.message_error = None
    except ThreadTenantMismatchError as error:
        context.message_error = error


@when('bot "{name}" posts "{body}" addressed to bot "{addressee}"')
def when_bot_posts(context: object, name: str, body: str, addressee: str) -> None:
    thread = _thread(context)
    author = context.bots_by_name[name]
    target = context.bots_by_name[addressee]
    context.last_message = context.plane.post_message(
        thread.thread_id,
        author.tenant_id,
        ActorKind.BOT,
        author.bot_id,
        body,
        addressed_to_bot_id=target.bot_id,
    )


@when('tenant "{tenant_id}" posts "{body}" on the thread')
def when_other_tenant_posts(context: object, tenant_id: str, body: str) -> None:
    thread = _thread(context)
    try:
        context.last_message = context.plane.post_message(
            thread.thread_id,
            tenant_id,
            ActorKind.HUMAN,
            "intruder",
            body,
        )
        context.message_error = None
    except ThreadTenantMismatchError as error:
        context.message_error = error


@then("the thread has {count:d} message")
def then_thread_message_count_one(context: object, count: int) -> None:
    then_thread_message_count(context, count)


@then("the thread has {count:d} messages")
def then_thread_message_count(context: object, count: int) -> None:
    thread = _thread(context)
    messages = context.plane.list_messages(thread.thread_id, thread.tenant_id)
    assert len(messages) == count


@then('the message with seq {seq:d} has body "{body}"')
def then_message_body(context: object, seq: int, body: str) -> None:
    thread = _thread(context)
    messages = {
        message.seq: message
        for message in context.plane.list_messages(thread.thread_id, thread.tenant_id)
    }
    assert messages[seq].body == body


@then('the message with seq {seq:d} is from the human "{user_id}"')
def then_message_from_human(context: object, seq: int, user_id: str) -> None:
    thread = _thread(context)
    messages = {
        message.seq: message
        for message in context.plane.list_messages(thread.thread_id, thread.tenant_id)
    }
    assert messages[seq].author_kind == ActorKind.HUMAN
    assert messages[seq].author_id == user_id


@then('the message with seq {seq:d} is from bot "{name}"')
def then_message_from_bot(context: object, seq: int, name: str) -> None:
    thread = _thread(context)
    bot = context.bots_by_name[name]
    messages = {
        message.seq: message
        for message in context.plane.list_messages(thread.thread_id, thread.tenant_id)
    }
    assert messages[seq].author_kind == ActorKind.BOT
    assert messages[seq].author_id == bot.bot_id


@then("the human can read both messages on the thread")
def then_human_reads_thread(context: object) -> None:
    thread = _thread(context)
    messages = context.plane.list_messages(thread.thread_id, thread.tenant_id)
    assert len(messages) == 2


@then('bot "{name}" has {count:d} pending turn')
def then_bot_pending_turn_one(context: object, name: str, count: int) -> None:
    then_bot_pending_turns(context, name, count)


@then('bot "{name}" has {count:d} pending turns')
def then_bot_pending_turns(context: object, name: str, count: int) -> None:
    bot = context.bots_by_name[name]
    assert len(context.plane.pending_jobs_for_bot(bot.bot_id)) == count


@then("posting fails because the tenant does not match")
def then_post_tenant_mismatch(context: object) -> None:
    assert isinstance(context.message_error, ThreadTenantMismatchError)


@given('tenant "{tenant_id}" is subscribed to the thread realtime API')
def given_subscribed(context: object, tenant_id: str) -> None:
    thread = _thread(context)
    context.last_subscription = context.plane.subscribe_realtime(
        thread.thread_id, tenant_id
    )


@when('tenant "{tenant_id}" subscribes to the thread realtime API')
def when_subscribe(context: object, tenant_id: str) -> None:
    thread = _thread(context)
    try:
        context.last_subscription = context.plane.subscribe_realtime(
            thread.thread_id, tenant_id
        )
        context.subscription_error = None
    except ThreadTenantMismatchError as error:
        context.subscription_error = error


@then("the realtime subscription fails because the tenant does not match")
def then_subscribe_tenant_mismatch(context: object) -> None:
    assert isinstance(context.subscription_error, ThreadTenantMismatchError)


@then('the subscription received event "{kind}" for seq {seq:d}')
def then_event_for_seq(context: object, kind: str, seq: int) -> None:
    events = context.last_subscription.events
    matching = [
        event
        for event in events
        if event.kind.value == kind and event.message_seq == seq
    ]
    assert matching, [event.kind.value for event in events]


@then('the subscription received event "{kind}" with token "{token}"')
def then_event_with_token(context: object, kind: str, token: str) -> None:
    events = context.last_subscription.events
    matching = [
        event for event in events if event.kind.value == kind and event.token == token
    ]
    assert matching, [(event.kind.value, event.token) for event in events]


@when('bot "{name}" starts a turn stream on the thread')
def when_start_stream(context: object, name: str) -> None:
    thread = _thread(context)
    bot = context.bots_by_name[name]
    context.last_stream_id = context.plane.start_turn_stream(
        thread.thread_id, thread.tenant_id, bot.bot_id
    )


@when('the turn stream appends token "{token}"')
def when_append_token(context: object, token: str) -> None:
    context.plane.append_turn_token(context.last_stream_id, token)


@when("the turn stream completes")
def when_complete_stream(context: object) -> None:
    context.last_message = context.plane.complete_turn_stream(context.last_stream_id)


@then("listing messages after seq {seq:d} returns {count:d} message")
def then_list_after_one(context: object, seq: int, count: int) -> None:
    then_list_after(context, seq, count)


@then("listing messages after seq {seq:d} returns {count:d} messages")
def then_list_after(context: object, seq: int, count: int) -> None:
    thread = _thread(context)
    context.listed_messages = context.plane.list_messages(
        thread.thread_id, thread.tenant_id, after_seq=seq
    )
    assert len(context.listed_messages) == count


@then('those messages start at seq {seq:d} with body "{body}"')
def then_listed_start(context: object, seq: int, body: str) -> None:
    assert context.listed_messages is not None
    assert context.listed_messages[0].seq == seq
    assert context.listed_messages[0].body == body
