"""Kernel tests for channels, turns, and the computerless worker."""

from __future__ import annotations

import boto3
import pytest
from moto import mock_aws

from chatticus.control_plane import ControlPlane
from chatticus.messaging.store import (
    DynamoMessagingStore,
    create_messaging_table,
)
from chatticus.models import (
    ActorKind,
    ChannelTenantMismatchError,
    TurnAccessDeniedError,
    TurnEventKind,
    TurnStatus,
)
from chatticus.worker.computerless import ComputerlessWorker, FakeTextCompletionClient


def _channel_with_bot(plane: ControlPlane, name: str = "Researcher"):
    bot = plane.create_bot("anthus", "ryan", name)
    channel = plane.create_channel("anthus", "ryan", [bot.bot_id])
    return bot, channel


@mock_aws
def test_dynamo_store_roundtrip_messages_and_events() -> None:
    table_name = "chatticus-messaging-test"
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_messaging_table(client, table_name)
    store = DynamoMessagingStore(table_name, client=client)
    plane = ControlPlane(messaging_store=store)
    bot, channel = _channel_with_bot(plane)
    plane.post_channel_message(
        channel.channel_id,
        channel.tenant_id,
        ActorKind.HUMAN,
        "ryan",
        "hello",
        addressed_to_bot_id=bot.bot_id,
    )
    messages = plane.list_channel_messages(channel.channel_id, channel.tenant_id)
    assert len(messages) == 1
    jobs = plane.pending_jobs_for_bot(bot.bot_id)
    assert jobs[0].required_capabilities == frozenset({"cpu"})
    turn_id = jobs[0].turn_id
    assert turn_id is not None
    plane.post_turn_chunk(turn_id, channel.tenant_id, "Hel")
    plane.complete_turn(channel.tenant_id, turn_id)
    messages = plane.list_channel_messages(channel.channel_id, channel.tenant_id)
    assert len(messages) == 2
    events = store.list_turn_events(channel.tenant_id, turn_id)
    assert events[0].kind == TurnEventKind.TURN_STARTED
    assert events[-1].kind == TurnEventKind.TURN_COMPLETED


def test_cross_tenant_channel_post_is_rejected() -> None:
    plane = ControlPlane()
    _, channel = _channel_with_bot(plane)
    with pytest.raises(ChannelTenantMismatchError):
        plane.post_channel_message(
            channel.channel_id,
            "other",
            ActorKind.HUMAN,
            "alex",
            "hello",
        )


def test_cpu_turn_does_not_pin_computer() -> None:
    plane = ControlPlane()
    bot, channel = _channel_with_bot(plane)
    plane.post_channel_message(
        channel.channel_id,
        channel.tenant_id,
        ActorKind.HUMAN,
        "ryan",
        "hello",
        addressed_to_bot_id=bot.bot_id,
    )
    jobs = plane.pending_jobs_for_bot(bot.bot_id)
    assert jobs[0].computer_id is None


def test_computerless_worker_commits_one_answer_with_fake_openai() -> None:
    plane = ControlPlane()
    plane.set_computer_stopped("anthus", "ryan", True)
    bot, channel = _channel_with_bot(plane, "Assistant")
    plane.post_channel_message(
        channel.channel_id,
        channel.tenant_id,
        ActorKind.HUMAN,
        "ryan",
        "ping",
        addressed_to_bot_id=bot.bot_id,
    )
    worker = ComputerlessWorker(
        plane,
        FakeTextCompletionClient(),
    )
    worker.complete_pending_for_bot(bot.bot_id)
    assert plane.computer_is_stopped("anthus", "ryan")
    messages = plane.list_channel_messages(channel.channel_id, channel.tenant_id)
    bot_messages = [m for m in messages if m.author_kind == ActorKind.BOT]
    assert len(bot_messages) == 1
    assert "You said: ping" in bot_messages[0].body


def test_turn_stream_replay_after_cursor() -> None:
    plane = ControlPlane()
    bot, channel = _channel_with_bot(plane)
    plane.post_channel_message(
        channel.channel_id,
        channel.tenant_id,
        ActorKind.HUMAN,
        "ryan",
        "hello",
        addressed_to_bot_id=bot.bot_id,
    )
    turn_id = plane.pending_jobs_for_bot(bot.bot_id)[0].turn_id
    assert turn_id is not None
    plane.post_turn_chunk(turn_id, channel.tenant_id, "Hel")
    plane.post_turn_chunk(turn_id, channel.tenant_id, "lo")
    plane.post_turn_chunk(turn_id, channel.tenant_id, "!")
    watcher = plane.open_turn_stream(turn_id, channel.tenant_id, after_seq=2)
    replayed = [event.seq for event in watcher.events]
    assert replayed == [3, 4]


def test_cross_tenant_turn_stream_is_denied() -> None:
    plane = ControlPlane()
    bot, channel = _channel_with_bot(plane)
    plane.post_channel_message(
        channel.channel_id,
        channel.tenant_id,
        ActorKind.HUMAN,
        "ryan",
        "hello",
        addressed_to_bot_id=bot.bot_id,
    )
    turn_id = plane.pending_jobs_for_bot(bot.bot_id)[0].turn_id
    assert turn_id is not None
    with pytest.raises(TurnAccessDeniedError):
        plane.open_turn_stream(turn_id, "other")


def test_turn_completes_without_watcher() -> None:
    plane = ControlPlane()
    bot, channel = _channel_with_bot(plane)
    plane.post_channel_message(
        channel.channel_id,
        channel.tenant_id,
        ActorKind.HUMAN,
        "ryan",
        "hello",
        addressed_to_bot_id=bot.bot_id,
    )
    turn_id = plane.pending_jobs_for_bot(bot.bot_id)[0].turn_id
    assert turn_id is not None
    plane.complete_turn(channel.tenant_id, turn_id)
    turn = plane.turn(channel.tenant_id, turn_id)
    assert turn.status == TurnStatus.COMPLETED
