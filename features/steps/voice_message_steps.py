"""Behavior steps for the understand-the-user step on spoken lines."""

from __future__ import annotations

from behave import given, then, when

from chatticus.http.paths import org_path
from chatticus.models import ActorKind
from chatticus.vendor_ledger import CompletionUsage
from chatticus.voice.understanding import RecentLine, Understanding


class ScriptedUserUnderstanding:
    """Turns known transcripts into scripted meanings and records what it saw."""

    def __init__(self) -> None:
        self.meanings: dict[str, str] = {}
        self.usages: dict[str, CompletionUsage] = {}
        self.unavailable = False
        self.calls: list[tuple[str, list[RecentLine]]] = []

    def understand(self, transcript: str, recent: list[RecentLine]) -> Understanding:
        self.calls.append((transcript, list(recent)))
        if self.unavailable:
            raise RuntimeError("model provider unavailable")
        return Understanding(
            text=self.meanings.get(transcript, transcript),
            usage=self.usages.get(transcript),
        )


def _understanding(context: object) -> ScriptedUserUnderstanding:
    understanding = getattr(context, "scripted_understanding", None)
    if understanding is None:
        understanding = ScriptedUserUnderstanding()
        context.scripted_understanding = understanding
        context.app_state.user_understanding = understanding
    return understanding


@given('the understand-the-user step hears "{transcript}" as "{meaning}"')
def given_understanding_hears(context: object, transcript: str, meaning: str) -> None:
    _understanding(context).meanings[transcript] = meaning


@given(
    'the understand-the-user step hears "{transcript}" as "{meaning}" '
    "using {input_tokens:d} input and {output_tokens:d} output tokens"
)
def given_understanding_hears_with_usage(
    context: object,
    transcript: str,
    meaning: str,
    input_tokens: int,
    output_tokens: int,
) -> None:
    understanding = _understanding(context)
    understanding.meanings[transcript] = meaning
    understanding.usages[transcript] = CompletionUsage(
        vendor="openai",
        model="gpt-5-nano",
        input_tokens=input_tokens,
        output_tokens=output_tokens,
    )


@given(
    'the understand-the-user step finds no message in "{transcript}" '
    "using {input_tokens:d} input and {output_tokens:d} output tokens"
)
def given_understanding_finds_nothing_with_usage(
    context: object, transcript: str, input_tokens: int, output_tokens: int
) -> None:
    given_understanding_hears_with_usage(
        context, transcript, "", input_tokens, output_tokens
    )


@given("the understand-the-user step is unavailable")
def given_understanding_unavailable(context: object) -> None:
    _understanding(context).unavailable = True


@given('the understand-the-user step finds no message in "{transcript}"')
def given_understanding_finds_nothing(context: object, transcript: str) -> None:
    _understanding(context).meanings[transcript] = ""


@given("the channel already has {count:d} messages")
def given_channel_has_messages(context: object, count: int) -> None:
    _understanding(context)
    channel = context.last_channel
    for index in range(count):
        response = context.api_client.post(
            org_path(channel.tenant_id, f"/channels/{channel.channel_id}/messages"),
            json={
                "author_kind": ActorKind.HUMAN,
                "author_id": "ryan",
                "body": f"Earlier line {index + 1}.",
                "enqueue_turn": False,
            },
        )
        assert response.status_code == 200, response.text


@when(
    'user "{user_id}" of tenant "{tenant_id}" says "{transcript}" '
    'to bot "{name}" on the channel'
)
def when_member_says_to_bot(
    context: object, user_id: str, tenant_id: str, transcript: str, name: str
) -> None:
    _understanding(context)
    channel = context.last_channel
    bot = context.bots_by_name[name]
    context.messages_before_voice_line = len(
        context.plane.list_channel_messages(channel.channel_id, tenant_id, 0)
    )
    response = context.api_client.post(
        org_path(tenant_id, f"/channels/{channel.channel_id}/voice-messages"),
        json={
            "author_id": user_id,
            "transcript": transcript,
            "addressed_to_bot_id": bot.bot_id,
        },
    )
    assert response.status_code == 200, response.text
    context.voice_message_response = response.json()
    context.last_turn_id = context.voice_message_response.get("turn_id")


@then('the latest message on the channel is "{body}" from user "{user_id}"')
def then_latest_message(context: object, body: str, user_id: str) -> None:
    channel = context.last_channel
    messages = context.plane.list_channel_messages(
        channel.channel_id, channel.tenant_id, 0
    )
    latest = messages[-1]
    assert latest.body == body, latest.body
    assert latest.author_id == user_id, latest.author_id


@then('that message starts a turn for bot "{name}"')
def then_message_starts_turn(context: object, name: str) -> None:
    turn_id = context.voice_message_response["turn_id"]
    assert turn_id, context.voice_message_response
    channel = context.last_channel
    turn = context.plane.turn(channel.tenant_id, turn_id)
    assert turn.bot_id == context.bots_by_name[name].bot_id


@then('the understand-the-user step was given "{body}" as recent conversation')
def then_understanding_given_context(context: object, body: str) -> None:
    _transcript, recent = context.scripted_understanding.calls[-1]
    assert any(line.text == body for line in recent), recent


@then("the understand-the-user step was given {count:d} recent messages")
def then_understanding_given_count(context: object, count: int) -> None:
    _transcript, recent = context.scripted_understanding.calls[-1]
    assert len(recent) == count, len(recent)


@then("no message is posted for that line")
def then_no_message_posted(context: object) -> None:
    channel = context.last_channel
    messages = context.plane.list_channel_messages(
        channel.channel_id, channel.tenant_id, 0
    )
    assert len(messages) == context.messages_before_voice_line
    assert context.voice_message_response["message"] is None


@then("no turn starts for that line")
def then_no_turn_starts(context: object) -> None:
    assert context.voice_message_response["turn_id"] is None


def _try_to_say(context: object, tenant_id: str, transcript: str, name: str) -> None:
    _understanding(context)
    channel = context.last_channel
    bot = context.bots_by_name[name]
    context.voice_message_http = context.api_client.post(
        org_path(tenant_id, f"/channels/{channel.channel_id}/voice-messages"),
        json={
            "author_id": "ryan",
            "transcript": transcript,
            "addressed_to_bot_id": bot.bot_id,
        },
    )


@when(
    'user "{user_id}" of tenant "{tenant_id}" tries to say "{transcript}" '
    'to bot "{name}" on the channel'
)
def when_member_tries_to_say(
    context: object, user_id: str, tenant_id: str, transcript: str, name: str
) -> None:
    _try_to_say(context, tenant_id, transcript, name)


@when(
    'user "{user_id}" of tenant "{tenant_id}" tries to say a {length:d}-character '
    'line to bot "{name}" on the channel'
)
def when_member_tries_to_say_long_line(
    context: object, user_id: str, tenant_id: str, length: int, name: str
) -> None:
    _try_to_say(context, tenant_id, "a" * length, name)


@then("the voice line is refused as forbidden")
def then_voice_line_forbidden(context: object) -> None:
    assert (
        context.voice_message_http.status_code == 403
    ), context.voice_message_http.text


@then("the voice line is refused as invalid")
def then_voice_line_invalid(context: object) -> None:
    assert (
        context.voice_message_http.status_code == 422
    ), context.voice_message_http.text


@then("the understand-the-user step was not asked")
def then_understanding_not_asked(context: object) -> None:
    assert context.scripted_understanding.calls == []


@then(
    "the organization has a voice understanding spend entry of {input_tokens:d} "
    "input and {output_tokens:d} output tokens"
)
def then_voice_spend_entry(
    context: object, input_tokens: int, output_tokens: int
) -> None:
    channel = context.last_channel
    rows = [
        row
        for row in context.plane.list_vendor_ledger_rows(channel.tenant_id)
        if row.turn_id.startswith("voice:")
    ]
    assert len(rows) == 1, rows
    assert rows[0].input_tokens == input_tokens, rows[0]
    assert rows[0].output_tokens == output_tokens, rows[0]


@then("the turn for that message has no spend from the understanding call")
def then_turn_has_no_understanding_spend(context: object) -> None:
    channel = context.last_channel
    row = context.plane.vendor_ledger_row(
        channel.tenant_id, context.voice_message_response["turn_id"]
    )
    assert row is None, row
