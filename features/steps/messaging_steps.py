"""Step definitions for channels, messages, and turn-scoped server-sent events."""

from __future__ import annotations

from behave import given, then, when


class MissingBehaviorError(AssertionError):
    """Raised when Gherkin describes behavior that is not implemented yet."""


def _missing(behavior: str) -> None:
    raise MissingBehaviorError(f"Missing behavior: {behavior}")


def _channel(context: object) -> object:
    if context.last_channel is None:
        _missing("channel API (open or resolve a channel)")
    return context.last_channel


def _bot_ids(context: object, table: object) -> list[str]:
    names = [table.headings[0].strip()] if table.headings else []
    names.extend(row.cells[0].strip() for row in table)
    names = [name for name in names if name]
    return [context.bots_by_name[name].bot_id for name in names]


@when('tenant "{tenant_id}" user "{user_id}" opens a channel with bots:')
def when_open_channel(context: object, tenant_id: str, user_id: str) -> None:
    _bot_ids(context, context.table)
    _missing("POST /channels to open a channel with tenant_id on every fixture")


@given('tenant "{tenant_id}" user "{user_id}" has opened a channel with bots:')
def given_open_channel(context: object, tenant_id: str, user_id: str) -> None:
    when_open_channel(context, tenant_id, user_id)


@given('tenant "{tenant_id}" user "{user_id}" has a channel with a named bot "{name}"')
def given_channel_with_named_bot(
    context: object, tenant_id: str, user_id: str, name: str
) -> None:
    if name not in context.bots_by_name:
        context.bots_by_name[name] = context.plane.create_bot(tenant_id, user_id, name)
    _missing("channel with a named bot and tenant_id on every fixture")


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
    _channel(context)
    context.bots_by_name[name]
    _missing(
        "POST /channels/{channel_id}/messages with tenant_id and addressed_to_bot_id"
    )


@when('bot "{name}" posts "{body}" addressed to bot "{addressee}" on the channel')
def when_bot_posts_on_channel(
    context: object, name: str, body: str, addressee: str
) -> None:
    _channel(context)
    context.bots_by_name[name]
    context.bots_by_name[addressee]
    _missing("bot posts a committed message on a channel with tenant_id")


@when('tenant "{tenant_id}" posts "{body}" on the channel')
def when_other_tenant_posts_on_channel(
    context: object, tenant_id: str, body: str
) -> None:
    _channel(context)
    _missing("POST /channels/{channel_id}/messages with tenant isolation")


@then("the channel has {count:d} message")
def then_channel_message_count_one(context: object, count: int) -> None:
    then_channel_message_count(context, count)


@then("the channel has {count:d} messages")
def then_channel_message_count(context: object, count: int) -> None:
    _channel(context)
    _missing("GET /channels/{channel_id}/messages?after=seq for durable messages")


@then('the message with seq {seq:d} has body "{body}"')
def then_message_body(context: object, seq: int, body: str) -> None:
    _channel(context)
    _missing("committed channel message rows keyed by tenant_id and seq")


@then('the message with seq {seq:d} is from the human "{user_id}"')
def then_message_from_human(context: object, seq: int, user_id: str) -> None:
    _channel(context)
    _missing("committed channel message author_kind human with tenant_id")


@then('the message with seq {seq:d} is from bot "{name}"')
def then_message_from_bot(context: object, seq: int, name: str) -> None:
    _channel(context)
    context.bots_by_name[name]
    _missing("committed channel message author_kind bot with tenant_id")


@then("the human can read both messages on the channel")
def then_human_reads_channel(context: object) -> None:
    _channel(context)
    _missing("GET /channels/{channel_id}/messages for the channel owner tenant")


@then('bot "{name}" has {count:d} pending turn with required capabilities:')
def then_bot_pending_turn_with_capabilities(
    context: object, name: str, count: int
) -> None:
    context.bots_by_name[name]
    _missing(
        "enqueue a turn with cpu-only required capabilities "
        "instead of hardcoded computer"
    )


@then("posting fails because the tenant does not match")
def then_post_tenant_mismatch(context: object) -> None:
    _missing("tenant_id isolation on channel message POST")


@given('tenant "{tenant_id}" user "{user_id}" household computer is stopped')
def given_household_computer_stopped(
    context: object, tenant_id: str, user_id: str
) -> None:
    _missing("household computer stopped state for tenant_id and user_id")


@when(
    'user "{user_id}" of tenant "{tenant_id}" posts a text-only message '
    'addressed to bot "{name}" on the channel'
)
def when_text_only_post_on_channel(
    context: object, user_id: str, tenant_id: str, name: str
) -> None:
    _channel(context)
    context.bots_by_name[name]
    _missing(
        "computerless turn: text-only message enqueues cpu-only turn "
        "without starting computer"
    )


@then('bot "{name}" completes one turn')
def then_bot_completes_one_turn(context: object, name: str) -> None:
    context.bots_by_name[name]
    _missing("computerless turn completes on a cpu-only worker without computer tools")


@then("the channel contains one durable bot answer")
def then_channel_has_durable_bot_answer(context: object) -> None:
    _channel(context)
    _missing("turn.completed commits one durable channel message row")


@then('tenant "{tenant_id}" user "{user_id}" household computer remains stopped')
def then_household_computer_remains_stopped(
    context: object, tenant_id: str, user_id: str
) -> None:
    _missing("computerless turn leaves household computer stopped")


@given('another tenant "{tenant_id}" knows the channel identifier')
def given_other_tenant_knows_channel(context: object, tenant_id: str) -> None:
    _channel(context)
    context.other_tenant_id = tenant_id


@when('tenant "{tenant_id}" tries to post or read on the channel')
def when_other_tenant_post_or_read(context: object, tenant_id: str) -> None:
    _channel(context)
    _missing("cross-tenant channel POST and GET denied by tenant_id")


@then("access is denied")
def then_access_denied(context: object) -> None:
    _missing("cross-tenant access denied for channel and turn fixtures")


@then("the channel is unchanged")
def then_channel_unchanged(context: object) -> None:
    _channel(context)
    _missing("channel transcript unchanged after denied cross-tenant access")


@given('bot "{name}" is producing an answer for a turn on the channel')
def given_bot_producing_turn(context: object, name: str) -> None:
    _channel(context)
    context.bots_by_name[name]
    _missing("active turn with durable chunk store keyed by turn_id and tenant_id")


@given(
    'user "{user_id}" of tenant "{tenant_id}" is watching that turn '
    "through server-sent events"
)
def given_watching_turn_sse(context: object, user_id: str, tenant_id: str) -> None:
    _missing("GET /turns/{turn_id}/stream opens a turn-scoped server-sent event stream")


@when("the worker posts several coalesced progress chunks for the turn")
def when_worker_posts_chunks(context: object) -> None:
    _missing("POST /turns/{turn_id}/chunks appends coalesced progress to durable store")


@then('user "{user_id}" receives the chunks in order before completion')
def then_receives_chunks_in_order(context: object, user_id: str) -> None:
    _missing(
        "turn-scoped SSE delivers turn.token chunks in order before terminal event"
    )


@then('user "{user_id}" receives one terminal server-sent event')
def then_receives_terminal_event(context: object, user_id: str) -> None:
    _missing("turn-scoped SSE delivers one terminal turn.completed event")


@then("the turn stream ends")
def then_turn_stream_ends(context: object) -> None:
    _missing("turn-scoped SSE stream ends when the turn completes")


@then("no connection remains open for the channel or chat tab")
def then_no_persistent_connection(context: object) -> None:
    _missing(
        "no persistent connection remains for the channel or tab after turn stream ends"
    )


@given("a turn has emitted committed events through sequence {seq:d}")
def given_turn_events_through_seq(context: object, seq: int) -> None:
    _missing("durable turn event store with monotonic sequence per turn_id")


@given("the watching connection for that turn closes")
def given_watching_connection_closes(context: object) -> None:
    _missing("client may close GET /turns/{turn_id}/stream without affecting the turn")


@when(
    'user "{user_id}" of tenant "{tenant_id}" reconnects to the turn '
    "after sequence {seq:d}"
)
def when_reconnect_after_seq(
    context: object, user_id: str, tenant_id: str, seq: int
) -> None:
    _missing("GET /turns/{turn_id}/stream?after=seq replays committed turn events")


@then("committed events 3 and 4 are replayed once in order")
def then_events_replayed_in_order(context: object) -> None:
    _missing(
        "durable turn event replay after=seq delivers events 3 and 4 once in order"
    )


@then("later events continue from the same turn")
def then_later_events_continue(context: object) -> None:
    _missing("reconnected SSE stream continues live events from the same turn")


@then("the turn completes whether or not a watcher remains connected")
def then_turn_completes_without_watcher(context: object) -> None:
    _missing("turn runs to completion independent of any SSE watcher")


@given('user "{user_id}" of tenant "{tenant_id}" has an active turn on the channel')
def given_active_turn_on_channel(context: object, user_id: str, tenant_id: str) -> None:
    _channel(context)
    _missing("active turn on a channel with tenant_id on turn fixture")


@when('tenant "{tenant_id}" tries to open the turn stream')
def when_other_opens_turn_stream(context: object, tenant_id: str) -> None:
    _missing("GET /turns/{turn_id}/stream denied for cross-tenant access")


@then("turn stream access is denied because the tenant does not match")
def then_turn_stream_tenant_denied(context: object) -> None:
    _missing("tenant_id isolation on GET /turns/{turn_id}/stream")
