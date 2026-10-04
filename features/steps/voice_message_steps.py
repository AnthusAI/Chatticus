"""Behavior steps for the understand-the-user step on spoken lines."""

from __future__ import annotations

from behave import given, then, when

from chatticus.http.paths import org_path
from chatticus.models import ActorKind
from chatticus.voice.understanding import RecentLine


class ScriptedUserUnderstanding:
    """Turns known transcripts into scripted meanings and records what it saw."""

    def __init__(self) -> None:
        self.meanings: dict[str, str] = {}
        self.calls: list[tuple[str, list[RecentLine]]] = []

    def understand(self, transcript: str, recent: list[RecentLine]) -> str:
        self.calls.append((transcript, list(recent)))
        return self.meanings.get(transcript, transcript)


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
