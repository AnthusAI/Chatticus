"""Behavior steps for voice control in the web workspace."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from behave import given, then, when

ROOT = Path(__file__).resolve().parents[2]
HARNESS = ROOT / "web" / "test-support" / "voice-harness.ts"


def _run_voice_harness(context: object, action: str, **values: object) -> dict:
    payload = {
        "action": action,
        "bots": context.voice_bots,
        "channels": context.voice_channels,
        "selectedId": getattr(context, "voice_selected_id", None),
        "addressedBotId": getattr(context, "voice_addressed_bot_id", None),
        "busyChannelIds": getattr(context, "voice_busy_channel_ids", []),
        "overlapsSpeech": getattr(context, "voice_speaking", False),
        "environment": getattr(
            context,
            "voice_environment",
            {"crossOriginIsolated": True, "hasMicrophone": True},
        ),
        **values,
    }
    completed = subprocess.run(
        ["npx", "tsx", str(HARNESS), json.dumps(payload)],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def _voice_bot(name: str) -> dict[str, object]:
    return {
        "bot_id": f"bot-{name.lower()}",
        "tenant_id": "tenant-1",
        "user_id": "user-1",
        "name": name,
        "memory": {},
    }


def _voice_channel(
    channel_id: str, name: str | None, bot_ids: list[str]
) -> dict[str, object]:
    return {
        "channel_id": channel_id,
        "tenant_id": "tenant-1",
        "user_id": "user-1",
        "kind": "named" if name else "direct",
        "name": name,
        "participants": [
            {"kind": "human", "actor_id": "user-1"},
            *({"kind": "bot", "actor_id": bot_id} for bot_id in bot_ids),
        ],
        "next_seq": 1,
    }


def _bot_id(context: object, name: str) -> str:
    return next(bot["bot_id"] for bot in context.voice_bots if bot["name"] == name)


@given('the voice workspace has teammates "{first}" and "{second}"')
def given_voice_teammates(context: object, first: str, second: str) -> None:
    context.voice_bots = [_voice_bot(first), _voice_bot(second)]
    context.voice_channels = []
    context.voice_selected_id = None
    context.voice_busy_channel_ids = []
    context.voice_speaking = False
    context.voice_listening = False


@given('the named channel "{name}" with "{first}" and "{second}" is open')
def given_open_named_channel(
    context: object, name: str, first: str, second: str
) -> None:
    channel_id = f"channel-{name.lower()}"
    context.voice_channels.append(
        _voice_channel(
            channel_id, name, [_bot_id(context, first), _bot_id(context, second)]
        )
    )
    context.voice_selected_id = f"channel:{channel_id}"
    context.voice_addressed_bot_id = _bot_id(context, first)


def _direct_channel_id(context: object, name: str) -> str:
    channel_id = f"channel-direct-{name.lower()}"
    if not any(c["channel_id"] == channel_id for c in context.voice_channels):
        context.voice_channels.append(
            _voice_channel(channel_id, None, [_bot_id(context, name)])
        )
    return channel_id


@given('the direct conversation with "{name}" is open')
def given_direct_conversation_open(context: object, name: str) -> None:
    _direct_channel_id(context, name)
    context.voice_selected_id = f"bot:{_bot_id(context, name)}"
    context.voice_addressed_bot_id = _bot_id(context, name)


@given('"{name}" is chosen to answer in that channel')
def given_teammate_chosen(context: object, name: str) -> None:
    context.voice_addressed_bot_id = _bot_id(context, name)


@given('"{name}" is already working on a turn in the direct conversation')
def given_teammate_busy(context: object, name: str) -> None:
    context.voice_busy_channel_ids = [_direct_channel_id(context, name)]


@given("the page is not cross-origin isolated")
def given_not_isolated(context: object) -> None:
    context.voice_environment = {"crossOriginIsolated": False, "hasMicrophone": True}


@given("the browser offers no microphone")
def given_no_microphone(context: object) -> None:
    context.voice_environment = {"crossOriginIsolated": True, "hasMicrophone": False}


@when('the member says "{line}"')
def when_member_says(context: object, line: str) -> None:
    context.voice_outcome = _run_voice_harness(context, "hear", line=line)


@when("the member asks to start listening")
def when_member_starts_listening(context: object) -> None:
    context.voice_outcome = _run_voice_harness(context, "availability")


@then("nothing leaves the browser")
def then_nothing_leaves(context: object) -> None:
    outcome = context.voice_outcome
    assert outcome["kind"] == "discard", outcome


@then("listening stops")
def then_listening_stops(context: object) -> None:
    assert context.voice_outcome == {"kind": "stopListening"}, context.voice_outcome


@then("no message is sent")
def then_no_message(context: object) -> None:
    assert context.voice_outcome["kind"] != "send", context.voice_outcome


@then('the member is told "{notice}"')
def then_member_told(context: object, notice: str) -> None:
    outcome = context.voice_outcome
    assert outcome["kind"] == "notice", outcome
    assert outcome["text"] == notice, outcome


@then('listening is unavailable because "{reason}"')
def then_unavailable(context: object, reason: str) -> None:
    assert context.voice_outcome == {
        "available": False,
        "reason": reason,
    }, context.voice_outcome


@given("voice listening is on")
def given_listening_on(context: object) -> None:
    context.voice_listening = True


@given("voice listening is off")
def given_listening_off(context: object) -> None:
    context.voice_listening = False


@given("a reply is being spoken")
def given_reply_being_spoken(context: object) -> None:
    context.voice_speaking = True


@given("a line began while a reply was being spoken")
def given_line_began_during_speech(context: object) -> None:
    context.voice_speaking = True


@given(
    'the member asked "{name}" "{prompt}" in a channel where "{other}" '
    'also answered "{other_answer}"'
)
def given_shared_channel_answers(
    context: object, name: str, prompt: str, other: str, other_answer: str
) -> None:
    def message(seq: int, kind: str, author: str, body: str) -> dict[str, object]:
        return {
            "message_id": f"message-{seq}",
            "channel_id": "channel-release",
            "tenant_id": "tenant-1",
            "seq": seq,
            "author_kind": kind,
            "author_id": author,
            "body": body,
            "addressed_to_bot_id": None,
            "created_at": "2026-10-04T18:00:00+00:00",
        }

    context.voice_committed = [
        message(1, "human", "user-1", prompt),
        message(2, "bot", _bot_id(context, other), other_answer),
    ]
    context.voice_turn_bot = name


def _announce(context: object, name: str, **outcome: str) -> None:
    context.voice_spoken = _run_voice_harness(
        context,
        "announceTurnEnd",
        botName=name,
        listening=context.voice_listening,
        **outcome,
    )["spoken"]


@when('"{name}" replies "{body}"')
def when_teammate_replies(context: object, name: str, body: str) -> None:
    context.voice_reply_body = body.replace("\\n", "\n")
    _announce(context, name, body=context.voice_reply_body)


@when('"{name}" replies with a reply of {count:d} sentences')
def when_teammate_replies_long(context: object, name: str, count: int) -> None:
    body = " ".join(
        f"Sentence number {index} explains one more detail of the work."
        for index in range(1, count + 1)
    )
    context.voice_reply_body = body
    _announce(context, name, body=body)


@when('the turn for "{name}" fails with reason "{reason}"')
def when_turn_fails(context: object, name: str, reason: str) -> None:
    _announce(context, name, reason=reason)


@then('the browser says "{text}"')
def then_browser_says(context: object, text: str) -> None:
    assert context.voice_spoken == text, context.voice_spoken


@then("the browser says nothing")
def then_browser_says_nothing(context: object) -> None:
    assert context.voice_spoken is None, context.voice_spoken


@then("the browser says only the first sentences of the reply")
def then_browser_says_first_sentences(context: object) -> None:
    spoken = context.voice_spoken
    assert spoken is not None
    assert spoken.startswith("Ada says: Sentence number 1 "), spoken
    assert "Sentence number 12" not in spoken, spoken


@then('the browser ends with "{text}"')
def then_browser_ends_with(context: object, text: str) -> None:
    assert context.voice_spoken.endswith(text), context.voice_spoken


@then("speaking stops")
def then_speaking_stops(context: object) -> None:
    assert context.voice_outcome == {"kind": "stopSpeaking"}, context.voice_outcome


@when('the turn for "{name}" ends with Ada\'s answer "{answer}"')
def when_turn_ends_with_answer(context: object, name: str, answer: str) -> None:
    committed = [
        *context.voice_committed,
        {
            **context.voice_committed[-1],
            "message_id": "message-3",
            "seq": 3,
            "author_id": _bot_id(context, name),
            "body": answer,
        },
    ]
    context.voice_spoken = _run_voice_harness(
        context,
        "announceEndedTurn",
        botName=name,
        listening=context.voice_listening,
        turn={"bot_id": _bot_id(context, name), "prompt_message_seq": 1},
        committed=committed,
    )["spoken"]


@then('"{text}" is sent to "{name}" for understanding')
def then_sent_for_understanding(context: object, text: str, name: str) -> None:
    outcome = context.voice_outcome
    assert outcome["kind"] == "send", outcome
    assert outcome["transcript"] == text, outcome
    assert outcome["botId"] == _bot_id(context, name), outcome
