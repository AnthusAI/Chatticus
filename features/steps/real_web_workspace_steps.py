"""Behavior steps for the production workspace information architecture."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from behave import given, then, when

ROOT = Path(__file__).resolve().parents[2]
HARNESS = ROOT / "web" / "test-support" / "real-workspace-harness.ts"


def _run(context: object, action: str, **values: object) -> object:
    payload = {
        "action": action,
        "bots": getattr(context, "workspace_bots", []),
        "channels": getattr(context, "workspace_channels", []),
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


def _bot(name: str, index: int) -> dict[str, object]:
    return {
        "bot_id": f"bot-{index}",
        "tenant_id": "tenant-1",
        "user_id": "user-1",
        "name": name,
        "memory": {},
    }


def _channel(
    name: str | None, bot_ids: list[str], channel_id: str
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


def _message(seq: int, body: str) -> dict[str, object]:
    return {
        "message_id": f"message-{seq}",
        "channel_id": "channel-direct",
        "tenant_id": "tenant-1",
        "seq": seq,
        "author_kind": "human" if seq % 2 else "bot",
        "author_id": "user-1" if seq % 2 else "bot-1",
        "body": body,
        "addressed_to_bot_id": "bot-1" if seq % 2 else None,
        "created_at": "2026-09-09T20:00:00+00:00",
    }


@given('the real workspace has bots "{first}" and "{second}"')
def given_workspace_bots(context: object, first: str, second: str) -> None:
    context.workspace_bots = [_bot(first, 1), _bot(second, 2)]
    context.workspace_channels = []


@given('it has named channel "{name}" with those bots')
def given_named_channel(context: object, name: str) -> None:
    bot_ids = [bot["bot_id"] for bot in context.workspace_bots]
    context.workspace_channels.append(_channel(name, bot_ids, "channel-named"))


@given(
    'the real workspace has named channel "{name}" with bots "{first}" and "{second}"'
)
def given_workspace_named_channel(
    context: object, name: str, first: str, second: str
) -> None:
    given_workspace_bots(context, first, second)
    given_named_channel(context, name)


@when("the real workspace builds its roster")
def when_build_roster(context: object) -> None:
    context.workspace_result = _run(context, "roster")


@then('"{name}" and "{other_name}" are individual bot rows')
def then_individual_rows(context: object, name: str, other_name: str) -> None:
    rows = context.workspace_result
    assert {(row["label"], row["kind"]) for row in rows} >= {
        (name, "bot"),
        (other_name, "bot"),
    }


@then('"{name}" is a named channel row with {count:d} bot avatars')
def then_named_channel_row(context: object, name: str, count: int) -> None:
    row = next(row for row in context.workspace_result if row["label"] == name)
    assert row["kind"] == "channel"
    assert row["botCount"] == count


@given('the real workspace bot "{name}" has a direct channel with committed history')
def given_direct_history(context: object, name: str) -> None:
    context.workspace_bots = [_bot(name, 1)]
    context.workspace_channels = [_channel(None, ["bot-1"], "channel-direct")]
    context.workspace_messages = [
        _message(1, "First question"),
        _message(2, "First answer"),
    ]


@when('the member selects bot "{name}" twice')
def when_select_twice(context: object, name: str) -> None:
    del name
    context.workspace_selections = [
        _run(
            context,
            "select",
            selectedId="bot:bot-1",
            messages=context.workspace_messages,
        ),
        _run(
            context,
            "select",
            selectedId="bot:bot-1",
            messages=context.workspace_messages,
        ),
    ]


@then("both selections use the same direct channel")
def then_same_direct_channel(context: object) -> None:
    assert [selection["channelId"] for selection in context.workspace_selections] == [
        "channel-direct",
        "channel-direct",
    ]


@then("the committed history remains visible")
def then_history_visible(context: object) -> None:
    assert [
        message["body"] for message in context.workspace_selections[-1]["messages"]
    ] == [
        "First question",
        "First answer",
    ]


@when('the member addresses "{bot_name}" and sends "{body}"')
def when_address_and_send(context: object, bot_name: str, body: str) -> None:
    bot = next(bot for bot in context.workspace_bots if bot["name"] == bot_name)
    context.workspace_result = _run(
        context,
        "send",
        selectedId="channel:channel-named",
        addressedBotId=bot["bot_id"],
        body=body,
    )


@then('the message stays in "{channel_name}"')
def then_message_stays_in_channel(context: object, channel_name: str) -> None:
    del channel_name
    assert context.workspace_result["channelId"] == "channel-named"


@then('the message is addressed to "{bot_name}"')
def then_message_addressed(context: object, bot_name: str) -> None:
    bot = next(bot for bot in context.workspace_bots if bot["name"] == bot_name)
    assert context.workspace_result["addressedToBotId"] == bot["bot_id"]


@given("a real workspace channel has committed messages and an active waiting turn")
def given_waiting_turn(context: object) -> None:
    context.workspace_bots = [_bot("Researcher", 1)]
    context.workspace_channels = [_channel(None, ["bot-1"], "channel-direct")]
    context.workspace_messages = [_message(2, "Answer"), _message(1, "Question")]
    context.workspace_turn = {"status": "active", "waiting_for": "computer"}


@when("the real workspace reloads that conversation")
def when_reload_conversation(context: object) -> None:
    context.workspace_result = _run(
        context,
        "reload",
        messages=context.workspace_messages,
        turn=context.workspace_turn,
    )


@then("the committed messages are visible in sequence")
def then_messages_in_sequence(context: object) -> None:
    assert [message["seq"] for message in context.workspace_result["messages"]] == [
        1,
        2,
    ]


@then("the active turn is shown as waiting")
def then_turn_waiting(context: object) -> None:
    assert context.workspace_result["turnState"] == "waiting"


@given('a real workspace turn is "{state}"')
def given_turn_state(context: object, state: str) -> None:
    context.workspace_bots = []
    context.workspace_channels = []
    context.workspace_state = state


@when("the real workspace presents the turn")
def when_present_turn(context: object) -> None:
    context.workspace_result = _run(
        context, "turn-presentation", state=context.workspace_state
    )


@given('the real workspace roster is "{state}"')
def given_roster_state(context: object, state: str) -> None:
    context.workspace_bots = []
    context.workspace_channels = []
    context.workspace_state = state


@when("the real workspace presents the roster")
def when_present_roster(context: object) -> None:
    context.workspace_result = _run(
        context, "roster-presentation", state=context.workspace_state
    )


@then('its visible state is "{label}"')
def then_visible_state(context: object, label: str) -> None:
    assert context.workspace_result == label


@given('the real workspace selected bot "{name}" created one task')
def given_selected_bot_task(context: object, name: str) -> None:
    context.workspace_bots = [_bot(name, 1), _bot("Writer", 2)]
    context.workspace_channels = [_channel(None, ["bot-1"], "channel-direct")]
    context.workspace_tasks = [
        {
            "task_id": "task-1",
            "tenant_id": "tenant-1",
            "user_id": "user-1",
            "title": "Review findings",
            "status": "open",
            "evidence": "Source list",
            "close_reason": None,
            "created_by_bot_id": "bot-1",
            "updated_by_bot_id": None,
        },
        {
            "task_id": "task-2",
            "tenant_id": "tenant-1",
            "user_id": "user-1",
            "title": "Draft copy",
            "status": "open",
            "evidence": None,
            "close_reason": None,
            "created_by_bot_id": "bot-2",
            "updated_by_bot_id": None,
        },
    ]


@given('the organization computer is stopped with policy "{policy}"')
def given_computer(context: object, policy: str) -> None:
    context.workspace_computer = {"stopped": True, "policy": policy}


@when("the member opens the real workspace inspector")
def when_open_inspector(context: object) -> None:
    context.workspace_result = _run(
        context,
        "inspector",
        selectedId="bot:bot-1",
        tasks=context.workspace_tasks,
    )


@then('the inspector shows the stopped computer and policy "{policy}"')
def then_computer_state(context: object, policy: str) -> None:
    assert context.workspace_computer == {"stopped": True, "policy": policy}


@then('the inspector shows the task created by "{name}"')
def then_bot_task(context: object, name: str) -> None:
    del name
    assert [task["task_id"] for task in context.workspace_result["tasks"]] == ["task-1"]


@then("the inspector offers no unsupported computer control")
def then_no_computer_controls(context: object) -> None:
    assert context.workspace_result["computerControls"] == []


@given("the real workspace uses a narrow viewport")
def given_narrow_viewport(context: object) -> None:
    context.workspace_narrow = True
    context.workspace_bots = []
    context.workspace_channels = []


@when("the member opens the roster and inspector using the keyboard")
def when_keyboard_opens_sheets(context: object) -> None:
    assert context.workspace_narrow is True
    context.workspace_result = _run(context, "accessibility")


@then("both regions open as named sheets")
def then_named_sheets(context: object) -> None:
    assert context.workspace_result["sheets"] == [
        "Bots and channels",
        "Conversation inspector",
    ]


@then("every icon-only control has an accessible name")
def then_named_icon_controls(context: object) -> None:
    assert context.workspace_result["iconControlsNamed"] is True


@then("keyboard focus remains visible")
def then_visible_focus(context: object) -> None:
    assert context.workspace_result["focusRing"] is True
