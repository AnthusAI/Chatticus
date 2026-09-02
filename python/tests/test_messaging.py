"""Kernel and HTTP tests for channels, turns, and the computerless worker."""

from __future__ import annotations

import json
import os
from dataclasses import replace
from datetime import timedelta
from uuid import uuid4

import boto3
import pytest
from conftest import register_worker_headers
from http_test_support import ensure_test_org, start_authed_test_server
from moto import mock_aws

from chatticus.computer_continuation_driver import prepare_computer_continuation
from chatticus.control_plane import ControlPlane
from chatticus.http.client import HttpTurnClient
from chatticus.http.paths import org_path
from chatticus.http.sse import cursor_from_last_event_id
from chatticus.messaging.store import (
    DynamoMessagingStore,
    InMemoryMessagingStore,
    create_messaging_table,
)
from chatticus.models import (
    ActorKind,
    ComputerlessCannotExecuteComputerJob,
    ComputerNotReadyError,
    ComputerWorkerHostNotReady,
    DuplicateBotNameError,
    StaleAttemptError,
    TurnEventKind,
    TurnJob,
    TurnNotWaitingError,
    TurnStatus,
    primary_human_participant,
)
from chatticus.turn_recovery import logical_enqueue_id
from chatticus.worker.computer import ComputerWorker
from chatticus.worker.computerless import (
    ComputerlessWorker,
    CountingTextCompletionClient,
    FakeTextCompletionClient,
)
from chatticus.worker.openai_completion import (
    OpenAITextCompletionClient,
    completion_client_from_env,
    load_local_env,
)


def _channel_with_bot(plane: ControlPlane, name: str = "Researcher"):
    bot = plane.create_bot("anthus", name, creator_user_id="ryan")
    channel = plane.create_channel("anthus", "ryan", [bot.bot_id])
    return bot, channel


def _client_for(plane: ControlPlane, *, environment: str | None = None):
    return start_authed_test_server(plane, environment=environment, invoke_key="")


def _worker_headers(
    api: object,
    tenant_id: str = "anthus",
    worker_id: str = "test-worker",
) -> dict[str, str]:
    return register_worker_headers(api, tenant_id, worker_id)


def test_http_health_names_environment() -> None:
    api = _client_for(ControlPlane(), environment="development")
    health = api.get("/health")
    assert health.status_code == 200
    assert health.json() == {"status": "ok", "environment": "development"}
    api.close()


def test_cursor_from_last_event_id() -> None:
    assert cursor_from_last_event_id(None) == 0
    assert cursor_from_last_event_id("") == 0
    assert cursor_from_last_event_id(" 4 ") == 4
    with pytest.raises(ValueError):
        cursor_from_last_event_id("seq-2")


def test_list_channel_messages_after_query_skips_earlier_seq() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    researcher = plane.create_bot("anthus", "Researcher", creator_user_id="ryan")
    writer = plane.create_bot("anthus", "Writer", creator_user_id="ryan")
    channel = plane.create_channel("anthus", "ryan", [researcher.bot_id, writer.bot_id])
    api.post(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "research then draft",
            "addressed_to_bot_id": researcher.bot_id,
        },
    )
    api.post(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.BOT,
            "author_id": researcher.bot_id,
            "body": "notes are in /workspace/accounts.md",
            "addressed_to_bot_id": writer.bot_id,
        },
    )
    listed = api.get(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        params={"after": 1},
    )
    assert listed.status_code == 200
    payloads = listed.json()["messages"]
    assert [item["seq"] for item in payloads] == [2]
    api.close()


def test_list_turn_events_after_query_skips_earlier_seq() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    bot, channel = _channel_with_bot(plane)
    post = api.post(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "hello",
            "addressed_to_bot_id": bot.bot_id,
        },
    )
    turn_id = post.json()["turn_id"]
    client = HttpTurnClient(api, channel.tenant_id)
    client.claim(turn_id, "events-worker")
    client.post_chunk(turn_id, "Hel")
    client.post_chunk(turn_id, "lo")
    client.post_chunk(turn_id, "!")
    listed = api.get(
        org_path("anthus", f"/turns/{turn_id}/events"),
        params={"after": 2},
    )
    assert listed.status_code == 200
    payloads = listed.json()["events"]
    assert [item["seq"] for item in payloads] == [3, 4]
    assert payloads[0]["kind"] == TurnEventKind.TURN_TOKEN
    assert payloads[1]["kind"] == TurnEventKind.TURN_TOKEN
    api.close()


@mock_aws
def test_dynamo_logical_enqueue_survives_a_new_control_plane() -> None:
    table_name = "chatticus-messaging-enqueue-test"
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_messaging_table(client, table_name)
    store = DynamoMessagingStore(table_name, client=client)
    enqueued: list[str] = []

    def capture(job: object) -> None:
        from chatticus.models import TurnJob

        assert isinstance(job, TurnJob)
        assert job.turn_id is not None
        enqueued.append(job.turn_id)

    first = ControlPlane(
        messaging_store=store,
        turn_enqueued=capture,
        recovery_enabled=True,
    )
    bot = first.create_bot("anthus", "Assistant", creator_user_id="ryan")
    channel = first.create_channel("anthus", "ryan", [bot.bot_id])
    _, started = first.post_channel_message(
        channel.channel_id,
        "anthus",
        ActorKind.HUMAN,
        "ryan",
        "hello",
        addressed_to_bot_id=bot.bot_id,
    )
    assert started is not None
    job = first.job_for_turn("anthus", started.turn_id)
    assert job is not None
    enqueue_id = logical_enqueue_id(started.turn_id)
    assert first.logical_enqueue_delivery_count == 1
    assert len(enqueued) == 1

    second = ControlPlane(
        messaging_store=store,
        turn_enqueued=capture,
        recovery_enabled=True,
    )
    assert not second.request_logical_enqueue(
        "anthus", started.turn_id, enqueue_id, job
    )
    assert second.logical_enqueue_delivery_count == 0
    assert len(enqueued) == 1


@mock_aws
def test_dynamo_store_roundtrip_messages_and_events() -> None:
    table_name = "chatticus-messaging-test"
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_messaging_table(client, table_name)
    store = DynamoMessagingStore(table_name, client=client)
    plane = ControlPlane(messaging_store=store)
    api = _client_for(plane)
    bot, channel = _channel_with_bot(plane)
    response = api.post(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "hello",
            "addressed_to_bot_id": bot.bot_id,
        },
    )
    assert response.status_code == 200
    turn_id = response.json()["turn_id"]
    assert turn_id is not None
    jobs = plane.pending_jobs_for_bot(bot.bot_id)
    assert jobs[0].required_capabilities == frozenset({"cpu"})
    turn_client = HttpTurnClient(api, channel.tenant_id)
    turn_client.claim(turn_id, "test-worker")
    turn_client.post_chunk(turn_id, "Hel")
    turn_client.post_chunk(turn_id, "", complete=True)
    messages = api.get(
        org_path(channel.tenant_id, f"/channels/{channel.channel_id}/messages"),
    ).json()["messages"]
    assert len(messages) == 2
    events = store.list_turn_events(channel.tenant_id, turn_id)
    assert events[0].kind == TurnEventKind.TURN_STARTED
    assert events[-1].kind == TurnEventKind.TURN_COMPLETED
    api.close()


@mock_aws
def test_dynamo_bot_memory_survives_a_new_control_plane() -> None:
    table_name = "chatticus-bot-memory-test"
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_messaging_table(client, table_name)
    store = DynamoMessagingStore(table_name, client=client)
    first = ControlPlane(messaging_store=store)
    bot = first.create_bot("anthus", "Researcher", creator_user_id="ryan")
    first.remember("anthus", bot.bot_id, "voice", "short and direct")
    second = ControlPlane(messaging_store=store)
    loaded = second.bot("anthus", bot.bot_id)
    assert loaded.memory["voice"] == "short and direct"
    channel = second.create_channel("anthus", "ryan", [bot.bot_id])
    _, started = second.post_channel_message(
        channel.channel_id,
        "anthus",
        ActorKind.HUMAN,
        "ryan",
        "hello",
        addressed_to_bot_id=bot.bot_id,
    )
    assert started is not None
    prompt = second.turn_prompt("anthus", started.turn_id)
    assert "memory voice: short and direct" in prompt.splitlines()
    assert prompt.splitlines()[-1].endswith("hello")


def test_remember_hydrates_bot_on_a_new_control_plane() -> None:
    store = InMemoryMessagingStore()
    first = ControlPlane(messaging_store=store)
    bot = first.create_bot("anthus", "Researcher", creator_user_id="ryan")
    second = ControlPlane(messaging_store=store)
    second.remember("anthus", bot.bot_id, "voice", "short and direct")
    assert second.memory("anthus", bot.bot_id, "voice") == "short and direct"


@mock_aws
def test_dynamo_remember_hydrates_bot_on_a_new_control_plane() -> None:
    table_name = "chatticus-bot-memory-write-recycle-test"
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_messaging_table(client, table_name)
    store = DynamoMessagingStore(table_name, client=client)
    bot = ControlPlane(messaging_store=store).create_bot(
        "anthus", "Researcher", creator_user_id="ryan"
    )
    second = ControlPlane(messaging_store=store)
    second.remember("anthus", bot.bot_id, "voice", "short and direct")
    assert second.memory("anthus", bot.bot_id, "voice") == "short and direct"


def test_http_bot_memory_write_on_a_new_control_plane() -> None:
    store = InMemoryMessagingStore()
    first = ControlPlane(messaging_store=store)
    bot = first.create_bot("anthus", "Researcher", creator_user_id="ryan")
    api = _client_for(ControlPlane(messaging_store=store))
    remembered = api.post(
        org_path("anthus", f"/bots/{bot.bot_id}/memory"),
        json={"key": "voice", "value": "short and direct"},
    )
    assert remembered.status_code == 200
    assert remembered.json()["memory"]["voice"] == "short and direct"
    api.close()


def test_http_lookup_bot_by_name() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    created = api.post(
        org_path("anthus", "/bots"),
        json={"name": "Researcher"},
    )
    bot_id = created.json()["bot_id"]
    fetched = api.get(
        org_path("anthus", "/bots"),
        params={"name": "Researcher"},
    )
    assert fetched.status_code == 200
    assert fetched.json()["bot_id"] == bot_id
    missing = api.get(
        org_path("other", "/bots"),
        params={"name": "Researcher"},
    )
    assert missing.status_code == 404
    unknown = api.get(
        org_path("anthus", "/bots"),
        params={"name": "Missing"},
    )
    assert unknown.status_code == 404
    api.close()


@mock_aws
def test_http_lookup_bot_by_name_survives_a_new_control_plane() -> None:
    table_name = "chatticus-bot-lookup-test"
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_messaging_table(client, table_name)
    store = DynamoMessagingStore(table_name, client=client)
    first = ControlPlane(messaging_store=store)
    bot = first.create_bot("anthus", "Researcher", creator_user_id="ryan")
    api = _client_for(ControlPlane(messaging_store=store))
    fetched = api.get(
        org_path("anthus", "/bots"),
        params={"name": "Researcher"},
    )
    assert fetched.status_code == 200
    assert fetched.json()["bot_id"] == bot.bot_id
    api.close()


def test_http_list_user_bots() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    researcher = api.post(
        org_path("anthus", "/bots"),
        json={"name": "Researcher"},
    )
    writer = api.post(
        org_path("anthus", "/bots"),
        json={"name": "Writer"},
    )
    ops = api.post(
        org_path("anthus", "/bots"),
        json={"name": "Ops"},
    )
    listed = api.get(
        org_path("anthus", "/users/ryan/bots"),
    )
    assert listed.status_code == 200
    bots = listed.json()["bots"]
    assert [bot["name"] for bot in bots] == ["Ops", "Researcher", "Writer"]
    assert {bot["bot_id"] for bot in bots} == {
        researcher.json()["bot_id"],
        writer.json()["bot_id"],
        ops.json()["bot_id"],
    }
    empty = api.get(
        org_path("other", "/users/ryan/bots"),
    )
    assert empty.status_code == 200
    assert empty.json()["bots"] == []
    api.close()


@mock_aws
def test_http_list_user_bots_survives_a_new_control_plane() -> None:
    table_name = "chatticus-bot-list-test"
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_messaging_table(client, table_name)
    store = DynamoMessagingStore(table_name, client=client)
    first = ControlPlane(messaging_store=store)
    ensure_test_org(first)
    researcher = first.create_bot("anthus", "Researcher", creator_user_id="ryan")
    writer = first.create_bot("anthus", "Writer", creator_user_id="ryan")
    ops = first.create_bot("anthus", "Ops", creator_user_id="alex")
    api = _client_for(ControlPlane(messaging_store=store))
    listed = api.get(
        org_path("anthus", "/users/ryan/bots"),
    )
    assert listed.status_code == 200
    bots = listed.json()["bots"]
    assert [bot["name"] for bot in bots] == ["Ops", "Researcher", "Writer"]
    assert {bot["bot_id"] for bot in bots} == {
        researcher.bot_id,
        writer.bot_id,
        ops.bot_id,
    }
    api.close()


def test_http_list_user_channels() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    bot = plane.create_bot("anthus", "Researcher", creator_user_id="ryan")
    first = api.post(
        org_path("anthus", "/channels"),
        json={"user_id": "ryan", "bot_ids": [bot.bot_id]},
    )
    second = api.post(
        org_path("anthus", "/channels"),
        json={"user_id": "ryan", "bot_ids": [bot.bot_id]},
    )
    api.post(
        org_path("anthus", "/channels"),
        json={
            "user_id": "alex",
            "bot_ids": [
                plane.create_bot("anthus", "Ops", creator_user_id="alex").bot_id
            ],
        },
    )
    listed = api.get(
        org_path("anthus", "/users/ryan/channels"),
    )
    assert listed.status_code == 200
    channels = listed.json()["channels"]
    assert [channel["channel_id"] for channel in channels] == sorted(
        [first.json()["channel_id"], second.json()["channel_id"]]
    )
    empty = api.get(
        org_path("other", "/users/ryan/channels"),
    )
    assert empty.status_code == 200
    assert empty.json()["channels"] == []
    api.close()


@mock_aws
def test_http_list_user_channels_survives_a_new_control_plane() -> None:
    table_name = "chatticus-channel-list-test"
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_messaging_table(client, table_name)
    store = DynamoMessagingStore(table_name, client=client)
    first = ControlPlane(messaging_store=store)
    ensure_test_org(first)
    bot = first.create_bot("anthus", "Researcher", creator_user_id="ryan")
    first_channel = first.create_channel("anthus", "ryan", [bot.bot_id])
    second_channel = first.create_channel("anthus", "ryan", [bot.bot_id])
    first.create_channel(
        "anthus",
        "alex",
        [first.create_bot("anthus", "Ops", creator_user_id="alex").bot_id],
    )
    api = _client_for(ControlPlane(messaging_store=store))
    listed = api.get(
        org_path("anthus", "/users/ryan/channels"),
    )
    assert listed.status_code == 200
    channels = listed.json()["channels"]
    assert [channel["channel_id"] for channel in channels] == sorted(
        [first_channel.channel_id, second_channel.channel_id]
    )
    api.close()


def test_http_list_user_active_turns() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    bot = plane.create_bot("anthus", "Researcher", creator_user_id="ryan")
    first = plane.create_channel("anthus", "ryan", [bot.bot_id])
    second = plane.create_channel("anthus", "ryan", [bot.bot_id])
    idle = plane.create_channel("anthus", "ryan", [bot.bot_id])
    other_bot = plane.create_bot("anthus", "Ops", creator_user_id="alex")
    other_channel = plane.create_channel("anthus", "alex", [other_bot.bot_id])
    first_turn = plane.post_channel_message(
        first.channel_id,
        "anthus",
        ActorKind.HUMAN,
        "ryan",
        "hello",
        addressed_to_bot_id=bot.bot_id,
        enqueue_turn=False,
    )[1]
    second_turn = plane.post_channel_message(
        second.channel_id,
        "anthus",
        ActorKind.HUMAN,
        "ryan",
        "hello",
        addressed_to_bot_id=bot.bot_id,
        enqueue_turn=False,
    )[1]
    plane.post_channel_message(
        other_channel.channel_id,
        "anthus",
        ActorKind.HUMAN,
        "alex",
        "hello",
        addressed_to_bot_id=other_bot.bot_id,
        enqueue_turn=False,
    )
    assert first_turn is not None
    assert second_turn is not None
    listed = api.get(
        org_path("anthus", "/users/ryan/turns"),
    )
    assert listed.status_code == 200
    turn_ids = [turn["turn_id"] for turn in listed.json()["turns"]]
    assert turn_ids == sorted([first_turn.turn_id, second_turn.turn_id])
    assert idle.channel_id not in {
        turn["channel_id"] for turn in listed.json()["turns"]
    }
    empty = api.get(
        org_path("other", "/users/ryan/turns"),
    )
    assert empty.status_code == 200
    assert empty.json()["turns"] == []
    api.close()


@mock_aws
def test_http_list_user_active_turns_survives_a_new_control_plane() -> None:
    table_name = "chatticus-turn-list-test"
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_messaging_table(client, table_name)
    store = DynamoMessagingStore(table_name, client=client)
    first = ControlPlane(messaging_store=store)
    bot = first.create_bot("anthus", "Researcher", creator_user_id="ryan")
    first_channel = first.create_channel("anthus", "ryan", [bot.bot_id])
    second_channel = first.create_channel("anthus", "ryan", [bot.bot_id])
    first_turn = first.post_channel_message(
        first_channel.channel_id,
        "anthus",
        ActorKind.HUMAN,
        "ryan",
        "hello",
        addressed_to_bot_id=bot.bot_id,
        enqueue_turn=False,
    )[1]
    second_turn = first.post_channel_message(
        second_channel.channel_id,
        "anthus",
        ActorKind.HUMAN,
        "ryan",
        "hello",
        addressed_to_bot_id=bot.bot_id,
        enqueue_turn=False,
    )[1]
    assert first_turn is not None
    assert second_turn is not None
    api = _client_for(ControlPlane(messaging_store=store))
    listed = api.get(
        org_path("anthus", "/users/ryan/turns"),
    )
    assert listed.status_code == 200
    turn_ids = [turn["turn_id"] for turn in listed.json()["turns"]]
    assert turn_ids == sorted([first_turn.turn_id, second_turn.turn_id])
    api.close()


@mock_aws
def test_http_list_user_active_turns_omits_completed() -> None:
    table_name = "chatticus-turn-list-done-test"
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_messaging_table(client, table_name)
    store = DynamoMessagingStore(table_name, client=client)
    plane = ControlPlane(messaging_store=store)
    bot = plane.create_bot("anthus", "Researcher", creator_user_id="ryan")
    done_channel = plane.create_channel("anthus", "ryan", [bot.bot_id])
    live_channel = plane.create_channel("anthus", "ryan", [bot.bot_id])
    done_turn = plane.post_channel_message(
        done_channel.channel_id,
        "anthus",
        ActorKind.HUMAN,
        "ryan",
        "hello",
        addressed_to_bot_id=bot.bot_id,
        enqueue_turn=False,
    )[1]
    live_turn = plane.post_channel_message(
        live_channel.channel_id,
        "anthus",
        ActorKind.HUMAN,
        "ryan",
        "hello",
        addressed_to_bot_id=bot.bot_id,
        enqueue_turn=False,
    )[1]
    assert done_turn is not None
    assert live_turn is not None
    api = _client_for(plane)
    claim = api.post(
        org_path("anthus", f"/turns/{done_turn.turn_id}/claim"),
        json={"worker_id": "test-worker"},
        headers=_worker_headers(api),
    )
    assert claim.status_code == 200
    complete = api.post(
        org_path("anthus", f"/turns/{done_turn.turn_id}/chunks"),
        json={
            "token": "done",
            "complete": True,
            "fence_token": claim.json()["fence_token"],
        },
        headers=_worker_headers(api),
    )
    assert complete.status_code == 200
    api.close()
    recycled = _client_for(ControlPlane(messaging_store=store))
    listed = recycled.get(
        org_path("anthus", "/users/ryan/turns"),
    )
    assert listed.status_code == 200
    turn_ids = [turn["turn_id"] for turn in listed.json()["turns"]]
    assert turn_ids == [live_turn.turn_id]
    recycled.close()


def test_http_get_user_computer() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    plane.create_bot("anthus", "Researcher", creator_user_id="ryan")
    plane.set_computer_stopped("anthus", True)
    expected = plane.computer_for_organization("anthus")
    fetched = api.get(
        org_path("anthus", "/users/ryan/computer"),
    )
    assert fetched.status_code == 200
    payload = fetched.json()
    assert payload["computer_id"] == expected.computer_id
    assert payload["stopped"] is True
    assert payload["host_start_generation"] == 0
    missing = api.get(
        org_path("other", "/users/ryan/computer"),
    )
    assert missing.status_code == 404
    api.close()


@mock_aws
def test_http_get_user_computer_survives_a_new_control_plane() -> None:
    table_name = "chatticus-computer-get-test"
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_messaging_table(client, table_name)
    store = DynamoMessagingStore(table_name, client=client)
    first = ControlPlane(messaging_store=store)
    first.create_bot("anthus", "Researcher", creator_user_id="ryan")
    first.set_computer_stopped("anthus", True)
    expected = first.computer_for_organization("anthus")
    api = _client_for(ControlPlane(messaging_store=store))
    fetched = api.get(
        org_path("anthus", "/users/ryan/computer"),
    )
    assert fetched.status_code == 200
    payload = fetched.json()
    assert payload["computer_id"] == expected.computer_id
    assert payload["stopped"] is True
    assert payload["host_start_generation"] == 0
    api.close()


def test_http_get_user_computer_reports_host_start_generation_after_nack() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    setup = prepare_computer_continuation(plane)
    with pytest.raises(ComputerWorkerHostNotReady):
        ComputerWorker(
            plane,
            HttpTurnClient(api, setup.tenant_id),
        ).run_job(setup.continuation_job)
    fetched = api.get(
        org_path("anthus", "/users/ryan/computer"),
    )
    assert fetched.status_code == 200
    assert fetched.json()["host_start_generation"] == 1
    api.close()


@mock_aws
def test_http_get_computer_sees_host_start_from_a_second_process() -> None:
    table_name = "chatticus-computer-host-start-second-process-test"
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_messaging_table(client, table_name)
    store = DynamoMessagingStore(table_name, client=client)
    door = ControlPlane(messaging_store=store)
    api = _client_for(door)
    prepare_computer_continuation(door)
    primed = api.get(
        org_path("anthus", "/users/ryan/computer"),
    )
    assert primed.status_code == 200
    assert primed.json()["host_start_generation"] == 0
    worker_plane = ControlPlane(messaging_store=store)
    worker_plane.request_computer_host_start("anthus", "host-start-from-second-process")
    fetched = api.get(
        org_path("anthus", "/users/ryan/computer"),
    )
    assert fetched.status_code == 200
    assert fetched.json()["host_start_generation"] == 1
    api.close()


@mock_aws
def test_dynamo_host_start_dispatch_is_claimed_once() -> None:
    table_name = "chatticus-host-start-dispatch-once-test"
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_messaging_table(client, table_name)
    store = DynamoMessagingStore(table_name, client=client)
    plane = ControlPlane(messaging_store=store)
    plane.ensure_computer("anthus", computer_id="household-computer")
    plane.request_computer_host_start("anthus", "turn-a")
    computer = plane.computer_for_organization("anthus")
    first = plane.mark_host_start_dispatched("anthus", computer.host_start_generation)
    second = plane.mark_host_start_dispatched("anthus", computer.host_start_generation)
    other = ControlPlane(messaging_store=store)
    third = other.mark_host_start_dispatched("anthus", computer.host_start_generation)
    assert first is True
    assert second is False
    assert third is False
    plane.release_host_start_dispatch("anthus", computer.host_start_generation)
    fourth = plane.mark_host_start_dispatched("anthus", computer.host_start_generation)
    assert fourth is True


@mock_aws
def test_http_get_user_computer_reports_host_start_generation_after_recycle() -> None:
    table_name = "chatticus-computer-host-start-generation-test"
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_messaging_table(client, table_name)
    store = DynamoMessagingStore(table_name, client=client)
    plane = ControlPlane(messaging_store=store)
    api = _client_for(plane)
    setup = prepare_computer_continuation(plane)
    with pytest.raises(ComputerWorkerHostNotReady):
        ComputerWorker(
            plane,
            HttpTurnClient(api, setup.tenant_id),
        ).run_job(setup.continuation_job)
    api.close()
    recycled = _client_for(ControlPlane(messaging_store=store))
    fetched = recycled.get(
        org_path("anthus", "/users/ryan/computer"),
    )
    assert fetched.status_code == 200
    assert fetched.json()["host_start_generation"] == 1
    recycled.close()


def test_http_get_channel_active_turn() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    bot, channel = _channel_with_bot(plane)
    posted = api.post(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "hello",
            "addressed_to_bot_id": bot.bot_id,
            "enqueue_turn": False,
        },
    )
    turn_id = posted.json()["turn_id"]
    fetched = api.get(
        org_path("anthus", f"/channels/{channel.channel_id}/turn"),
    )
    assert fetched.status_code == 200
    assert fetched.json()["turn_id"] == turn_id
    missing = api.get(
        org_path("other", f"/channels/{channel.channel_id}/turn"),
    )
    assert missing.status_code == 404
    api.close()


@mock_aws
def test_http_get_channel_active_turn_survives_a_new_control_plane() -> None:
    table_name = "chatticus-channel-turn-test"
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_messaging_table(client, table_name)
    store = DynamoMessagingStore(table_name, client=client)
    first = ControlPlane(messaging_store=store)
    bot, channel = _channel_with_bot(first)
    started = first.post_channel_message(
        channel.channel_id,
        channel.tenant_id,
        ActorKind.HUMAN,
        "ryan",
        "hello",
        addressed_to_bot_id=bot.bot_id,
        enqueue_turn=False,
    )[1]
    assert started is not None
    api = _client_for(ControlPlane(messaging_store=store))
    fetched = api.get(
        org_path("anthus", f"/channels/{channel.channel_id}/turn"),
    )
    assert fetched.status_code == 200
    assert fetched.json()["turn_id"] == started.turn_id
    api.close()


@mock_aws
def test_http_get_channel_active_turn_404_after_completion() -> None:
    table_name = "chatticus-channel-turn-done-test"
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_messaging_table(client, table_name)
    store = DynamoMessagingStore(table_name, client=client)
    plane = ControlPlane(messaging_store=store)
    bot, channel = _channel_with_bot(plane)
    started = plane.post_channel_message(
        channel.channel_id,
        channel.tenant_id,
        ActorKind.HUMAN,
        "ryan",
        "hello",
        addressed_to_bot_id=bot.bot_id,
        enqueue_turn=False,
    )[1]
    assert started is not None
    api = _client_for(plane)
    claim = api.post(
        org_path("anthus", f"/turns/{started.turn_id}/claim"),
        json={"worker_id": "test-worker"},
        headers=_worker_headers(api),
    )
    assert claim.status_code == 200
    fence_token = claim.json()["fence_token"]
    complete = api.post(
        org_path("anthus", f"/turns/{started.turn_id}/chunks"),
        json={
            "token": "done",
            "complete": True,
            "fence_token": fence_token,
        },
        headers=_worker_headers(api),
    )
    assert complete.status_code == 200
    api.close()
    recycled = _client_for(ControlPlane(messaging_store=store))
    missing = recycled.get(
        org_path("anthus", f"/channels/{channel.channel_id}/turn"),
    )
    assert missing.status_code == 404
    recycled.close()


@mock_aws
def test_http_get_channel_waiting_turn_survives_a_new_control_plane() -> None:
    table_name = "chatticus-channel-turn-waiting-test"
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_messaging_table(client, table_name)
    store = DynamoMessagingStore(table_name, client=client)
    plane = ControlPlane(messaging_store=store)
    bot, channel = _channel_with_bot(plane)
    started = plane.post_channel_message(
        channel.channel_id,
        channel.tenant_id,
        ActorKind.HUMAN,
        "ryan",
        "hello",
        addressed_to_bot_id=bot.bot_id,
        enqueue_turn=False,
    )[1]
    assert started is not None
    api = _client_for(plane)
    claim = api.post(
        org_path("anthus", f"/turns/{started.turn_id}/claim"),
        json={"worker_id": "test-worker"},
        headers=_worker_headers(api),
    )
    assert claim.status_code == 200
    fence_token = claim.json()["fence_token"]
    waiting = api.post(
        org_path("anthus", f"/turns/{started.turn_id}/waiting"),
        json={"gate": "browser", "fence_token": fence_token},
        headers=_worker_headers(api),
    )
    assert waiting.status_code == 200
    api.close()
    recycled = _client_for(ControlPlane(messaging_store=store))
    fetched = recycled.get(
        org_path("anthus", f"/channels/{channel.channel_id}/turn"),
    )
    assert fetched.status_code == 200
    payload = fetched.json()
    assert payload["turn_id"] == started.turn_id
    assert payload["waiting_for"] == "browser"
    pending = payload.get("pending_computer_tool")
    assert pending is not None
    assert pending["tool_name"] == "request_computer_capability"
    recycled.close()


def test_http_bot_memory_roundtrip() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    created = api.post(
        org_path("anthus", "/bots"),
        json={"name": "Researcher"},
    )
    bot_id = created.json()["bot_id"]
    remembered = api.post(
        org_path("anthus", f"/bots/{bot_id}/memory"),
        json={"key": "voice", "value": "short and direct"},
    )
    assert remembered.status_code == 200
    assert remembered.json()["memory"]["voice"] == "short and direct"
    fetched = api.get(
        org_path("anthus", f"/bots/{bot_id}"),
    )
    assert fetched.status_code == 200
    assert fetched.json()["memory"]["voice"] == "short and direct"
    missing = api.get(
        org_path("other", f"/bots/{bot_id}"),
    )
    assert missing.status_code == 404
    api.close()


@mock_aws
def test_channel_messages_survive_a_new_control_plane_in_dynamo() -> None:
    table_name = "chatticus-messaging-survival-test"
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_messaging_table(client, table_name)
    store = DynamoMessagingStore(table_name, client=client)
    first = ControlPlane(messaging_store=store)
    bot, channel = _channel_with_bot(first)
    first.post_channel_message(
        channel.channel_id,
        channel.tenant_id,
        ActorKind.HUMAN,
        "ryan",
        "hello",
        addressed_to_bot_id=bot.bot_id,
        enqueue_turn=False,
    )
    second = ControlPlane(messaging_store=store)
    messages = second.list_channel_messages(channel.channel_id, channel.tenant_id)
    assert len(messages) == 1
    assert messages[0].body == "hello"


@mock_aws
def test_second_control_plane_enqueues_a_turn_for_a_stored_bot() -> None:
    table_name = "chatticus-messaging-bot-hydrate-test"
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_messaging_table(client, table_name)
    store = DynamoMessagingStore(table_name, client=client)
    first = ControlPlane(messaging_store=store)
    bot, channel = _channel_with_bot(first)
    second = ControlPlane(messaging_store=store)
    _, started = second.post_channel_message(
        channel.channel_id,
        channel.tenant_id,
        ActorKind.HUMAN,
        "ryan",
        "hello again",
        addressed_to_bot_id=bot.bot_id,
    )
    assert started is not None
    job = second.job_for_turn(channel.tenant_id, started.turn_id)
    assert job is not None
    assert job.bot_id == bot.bot_id


def test_cross_tenant_channel_post_is_rejected() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    _, channel = _channel_with_bot(plane)
    response = api.post(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "alex",
            "body": "hello",
        },
    )
    assert response.status_code == 403
    api.close()


def test_cpu_turn_does_not_pin_computer() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    bot, channel = _channel_with_bot(plane)
    api.post(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "hello",
            "addressed_to_bot_id": bot.bot_id,
        },
    )
    jobs = plane.pending_jobs_for_bot(bot.bot_id)
    assert jobs[0].computer_id is None
    api.close()


def test_computerless_worker_commits_one_answer_with_fake_openai() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    plane.set_computer_stopped("anthus", True)
    bot, channel = _channel_with_bot(plane, "Assistant")
    api.post(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "ping",
            "addressed_to_bot_id": bot.bot_id,
        },
    )
    worker = ComputerlessWorker(
        plane,
        HttpTurnClient(api, channel.tenant_id),
        FakeTextCompletionClient(),
    )
    worker.complete_pending_for_bot(bot.bot_id)
    assert plane.computer_is_stopped("anthus")
    messages = api.get(
        org_path(channel.tenant_id, f"/channels/{channel.channel_id}/messages"),
    ).json()["messages"]
    bot_messages = [m for m in messages if m["author_kind"] == ActorKind.BOT]
    assert len(bot_messages) == 1
    assert "You said: ping" in bot_messages[0]["body"]
    api.close()


def test_computerless_worker_waits_when_the_model_needs_the_browser() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    plane.set_computer_stopped("anthus", True)
    bot, channel = _channel_with_bot(plane, "Assistant")
    post = api.post(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "research this and open the household browser",
            "addressed_to_bot_id": bot.bot_id,
        },
    )
    turn_id = post.json()["turn_id"]
    worker = ComputerlessWorker(
        plane,
        HttpTurnClient(api, channel.tenant_id),
        FakeTextCompletionClient(),
    )
    worker.complete_pending_for_bot(bot.bot_id)
    turn = plane.turn(channel.tenant_id, turn_id)
    assert turn.status == TurnStatus.ACTIVE
    assert turn.claimed_by_worker_id is None
    assert turn.waiting_for == "browser"
    events = plane.list_turn_events(channel.tenant_id, turn_id)
    waiting = [event for event in events if event.kind == TurnEventKind.TURN_WAITING]
    assert len(waiting) == 1
    assert waiting[0].body == "browser"
    pending = waiting[0].pending_computer_tool
    assert pending is not None
    assert pending.tool_name == "request_computer_capability"
    assert pending.arguments == {"gate": "browser"}
    assert pending.action_id
    messages = api.get(
        org_path(channel.tenant_id, f"/channels/{channel.channel_id}/messages"),
    ).json()["messages"]
    bot_messages = [m for m in messages if m["author_kind"] == ActorKind.BOT]
    assert bot_messages == []
    api.close()


def test_computerless_worker_does_not_recall_model_on_a_waiting_turn() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    plane.set_computer_stopped("anthus", True)
    bot, channel = _channel_with_bot(plane, "Assistant")
    post = api.post(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "research this and open the household browser",
            "addressed_to_bot_id": bot.bot_id,
        },
    )
    turn_id = post.json()["turn_id"]
    counting = CountingTextCompletionClient()
    worker = ComputerlessWorker(
        plane,
        HttpTurnClient(api, channel.tenant_id),
        counting,
    )
    worker.complete_pending_for_bot(bot.bot_id)
    turn = plane.turn(channel.tenant_id, turn_id)
    action_id = turn.pending_computer_action_id
    assert action_id
    assert counting.calls == 1
    worker.run_job(
        TurnJob(
            job_id=str(uuid4()),
            tenant_id=channel.tenant_id,
            required_capabilities=frozenset({"cpu"}),
            user_id=primary_human_participant(channel),
            bot_id=bot.bot_id,
            turn_id=turn_id,
        )
    )
    assert counting.calls == 1
    again = plane.turn(channel.tenant_id, turn_id)
    assert again.status == TurnStatus.ACTIVE
    assert again.waiting_for == "browser"
    assert again.pending_computer_action_id == action_id
    assert again.claimed_by_worker_id is None
    api.close()


def test_completion_client_from_env_without_key_is_fake(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "chatticus.worker.openai_completion.load_local_env",
        lambda: None,
    )
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    client = completion_client_from_env()
    assert isinstance(client, FakeTextCompletionClient)


@pytest.mark.live_openai
def test_computerless_worker_commits_one_answer_with_live_openai() -> None:
    load_local_env()
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        pytest.skip("OPENAI_API_KEY is not set")
    model = os.environ.get("OPENAI_MODEL", "gpt-5.6-luna").strip() or "gpt-5.6-luna"
    plane = ControlPlane()
    api = _client_for(plane)
    plane.set_computer_stopped("anthus", True)
    bot, channel = _channel_with_bot(plane, "Assistant")
    post = api.post(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "Reply with a short greeting.",
            "addressed_to_bot_id": bot.bot_id,
        },
    )
    turn_id = post.json()["turn_id"]
    assert turn_id is not None
    worker = ComputerlessWorker(
        plane,
        HttpTurnClient(api, channel.tenant_id),
        OpenAITextCompletionClient(api_key, model),
    )
    worker.complete_pending_for_bot(bot.bot_id)
    assert plane.computer_is_stopped("anthus")
    turn = plane.turn(channel.tenant_id, turn_id)
    assert turn.status == TurnStatus.COMPLETED
    messages = api.get(
        org_path(channel.tenant_id, f"/channels/{channel.channel_id}/messages"),
    ).json()["messages"]
    bot_messages = [m for m in messages if m["author_kind"] == ActorKind.BOT]
    assert len(bot_messages) == 1
    assert bot_messages[0]["body"].strip()
    events: list[dict[str, object]] = []
    with api.stream(
        "GET",
        org_path(channel.tenant_id, f"/turns/{turn_id}/stream"),
    ) as response:
        assert response.headers["content-type"].startswith("text/event-stream")
        buffer = ""
        for chunk in response.iter_bytes():
            buffer += chunk.decode()
            while "\n\n" in buffer:
                frame, buffer = buffer.split("\n\n", 1)
                for line in frame.split("\n"):
                    if line.startswith("data:"):
                        events.append(json.loads(line[5:].strip()))
            if events and events[-1].get("kind") == "turn.completed":
                break
    assert any(event.get("kind") == "turn.completed" for event in events)
    api.close()


def test_http_sse_replay_from_last_event_id() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    bot, channel = _channel_with_bot(plane)
    post = api.post(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "hello",
            "addressed_to_bot_id": bot.bot_id,
        },
    )
    turn_id = post.json()["turn_id"]
    turn_client = HttpTurnClient(api, channel.tenant_id)
    turn_client.claim(turn_id, "test-worker")
    turn_client.post_chunk(turn_id, "Hel")
    turn_client.post_chunk(turn_id, "lo")
    turn_client.post_chunk(turn_id, "!")
    turn_client.post_chunk(turn_id, "", complete=True)
    events: list[dict[str, object]] = []
    sse_ids: list[str] = []
    with api.stream(
        "GET",
        org_path(channel.tenant_id, f"/turns/{turn_id}/stream"),
        headers={
            "Last-Event-ID": "2",
        },
    ) as response:
        buffer = ""
        for chunk in response.iter_bytes():
            buffer += chunk.decode()
            while "\n\n" in buffer:
                frame, buffer = buffer.split("\n\n", 1)
                event_id = None
                payload = None
                for line in frame.split("\n"):
                    if line.startswith("id:"):
                        event_id = line[3:].strip()
                    if line.startswith("data:"):
                        payload = json.loads(line[5:].strip())
                if payload is not None:
                    events.append(payload)
                    if event_id is not None:
                        sse_ids.append(event_id)
            if len(events) >= 2:
                break
    replayed = [event["seq"] for event in events[:2]]
    assert replayed == [3, 4]
    assert sse_ids[:2] == ["3", "4"]
    api.close()


def test_http_sse_rejects_non_numeric_last_event_id() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    bot, channel = _channel_with_bot(plane)
    post = api.post(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "hello",
            "addressed_to_bot_id": bot.bot_id,
        },
    )
    turn_id = post.json()["turn_id"]
    response = api.get(
        org_path(channel.tenant_id, f"/turns/{turn_id}/stream"),
        headers={
            "Last-Event-ID": "not-a-seq",
        },
    )
    assert response.status_code == 400
    api.close()


def test_http_cross_tenant_turn_stream_is_denied() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    bot, channel = _channel_with_bot(plane)
    post = api.post(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "hello",
            "addressed_to_bot_id": bot.bot_id,
        },
    )
    turn_id = post.json()["turn_id"]
    response = api.get(
        org_path("other", f"/turns/{turn_id}/stream"),
    )
    assert response.status_code == 403
    api.close()


def test_http_waiting_emits_gate_and_releases_claim() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    bot, channel = _channel_with_bot(plane)
    post = api.post(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "open the household browser",
            "addressed_to_bot_id": bot.bot_id,
        },
    )
    turn_id = post.json()["turn_id"]
    client = HttpTurnClient(api, channel.tenant_id)
    claimed = client.claim(turn_id, "waiting-worker")
    assert claimed["acquired"] is True
    client.post_chunk(turn_id, "Here is a draft.")
    client.post_waiting(turn_id, "browser")
    turn = plane.turn(channel.tenant_id, turn_id)
    assert turn.status == TurnStatus.ACTIVE
    assert turn.claimed_by_worker_id is None
    assert turn.waiting_for == "browser"
    events = plane.list_turn_events(channel.tenant_id, turn_id)
    waiting = [event for event in events if event.kind == TurnEventKind.TURN_WAITING]
    assert len(waiting) == 1
    assert waiting[0].body == "browser"
    pending = waiting[0].pending_computer_tool
    assert pending is not None
    assert pending.tool_name == "request_computer_capability"
    assert pending.arguments == {"gate": "browser"}
    assert pending.action_id
    stale = api.post(
        org_path("anthus", f"/turns/{turn_id}/waiting"),
        json={"gate": "browser", "fence_token": claimed["fence_token"]},
        headers=_worker_headers(api, worker_id="waiting-worker"),
    )
    assert stale.status_code == 409
    plane.set_computer_stopped("anthus", True)
    refused = api.post(
        org_path(channel.tenant_id, f"/turns/{turn_id}/resume"),
        headers=_worker_headers(api, worker_id="waiting-worker"),
    )
    assert refused.status_code == 409
    with pytest.raises(ComputerNotReadyError):
        plane.resume_waiting_turn(channel.tenant_id, turn_id)
    still = plane.turn(channel.tenant_id, turn_id)
    assert still.status == TurnStatus.ACTIVE
    assert still.waiting_for == "browser"
    assert still.claimed_by_worker_id is None
    api.close()


def test_http_get_turn_exposes_waiting_gate() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    bot, channel = _channel_with_bot(plane)
    post = api.post(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "open the household browser",
            "addressed_to_bot_id": bot.bot_id,
        },
    )
    turn_id = post.json()["turn_id"]
    client = HttpTurnClient(api, channel.tenant_id)
    client.claim(turn_id, "waiting-worker")
    client.post_chunk(turn_id, "Here is a draft.")
    client.post_waiting(turn_id, "browser")
    response = api.get(
        org_path(channel.tenant_id, f"/turns/{turn_id}"),
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["turn_id"] == turn_id
    assert payload["status"] == "active"
    assert payload["waiting_for"] == "browser"
    pending = payload["pending_computer_tool"]
    assert pending["tool_name"] == "request_computer_capability"
    assert pending["arguments"] == {"gate": "browser"}
    assert pending["action_id"]
    second = api.get(
        org_path(channel.tenant_id, f"/turns/{turn_id}"),
    )
    assert second.json()["pending_computer_tool"]["action_id"] == pending["action_id"]
    events = plane.list_turn_events(channel.tenant_id, turn_id)
    waiting = [event for event in events if event.kind == TurnEventKind.TURN_WAITING]
    assert waiting[0].pending_computer_tool is not None
    assert waiting[0].pending_computer_tool.action_id == pending["action_id"]
    denied = api.get(
        org_path("other", f"/turns/{turn_id}"),
    )
    assert denied.status_code == 403
    api.close()


def test_resume_enqueues_the_same_turn_when_the_computer_is_running() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    bot, channel = _channel_with_bot(plane)
    post = api.post(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "open the household browser",
            "addressed_to_bot_id": bot.bot_id,
        },
    )
    turn_id = post.json()["turn_id"]
    client = HttpTurnClient(api, channel.tenant_id)
    client.claim(turn_id, "waiting-worker")
    client.post_chunk(turn_id, "Here is a draft.")
    client.post_waiting(turn_id, "browser")
    plane.set_computer_stopped("anthus", False)
    resumed = api.post(
        org_path(channel.tenant_id, f"/turns/{turn_id}/resume"),
        headers=_worker_headers(api, worker_id="resume-worker"),
    )
    assert resumed.status_code == 200
    payload = resumed.json()
    assert payload["turn_id"] == turn_id
    assert payload["gate"] == "browser"
    assert payload["required_capabilities"] == ["computer"]
    job = plane.job_for_turn(channel.tenant_id, turn_id)
    assert job is not None
    assert job.job_id == payload["job_id"]
    assert job.turn_id == turn_id
    assert "computer" in job.required_capabilities
    turn = plane.turn(channel.tenant_id, turn_id)
    assert turn.status == TurnStatus.ACTIVE
    assert turn.waiting_for == "browser"
    api.close()


def test_post_message_without_enqueue_creates_turn_without_cpu_job() -> None:
    captured: list[TurnJob] = []
    plane = ControlPlane(turn_enqueued=captured.append)
    api = _client_for(plane)
    bot, channel = _channel_with_bot(plane, "Assistant")
    posted = api.post(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "Fence probe; do not wait on this turn.",
            "addressed_to_bot_id": bot.bot_id,
            "enqueue_turn": False,
        },
    )
    assert posted.status_code == 200
    turn_id = posted.json()["turn_id"]
    assert turn_id
    assert captured == []
    assert plane.pending_jobs_for_bot(bot.bot_id) == []
    assert plane.job_for_turn(channel.tenant_id, turn_id) is None
    turn = plane.turn(channel.tenant_id, turn_id)
    assert turn.bot_id == bot.bot_id
    first = api.post(
        org_path("anthus", f"/turns/{turn_id}/claim"),
        json={"worker_id": "exercise-fence-a"},
        headers=_worker_headers(api, worker_id="exercise-fence-a"),
    )
    second = api.post(
        org_path("anthus", f"/turns/{turn_id}/claim"),
        json={"worker_id": "exercise-fence-b"},
        headers=_worker_headers(api, worker_id="exercise-fence-b"),
    )
    assert first.status_code == 200
    assert first.json().get("acquired") is True
    assert second.status_code == 409
    api.close()


def test_http_post_idempotency_key_does_not_duplicate() -> None:
    captured: list[TurnJob] = []
    plane = ControlPlane(turn_enqueued=captured.append)
    api = _client_for(plane)
    bot, channel = _channel_with_bot(plane, "Assistant")
    payload = {
        "author_kind": ActorKind.HUMAN,
        "author_id": "ryan",
        "body": "hello",
        "addressed_to_bot_id": bot.bot_id,
        "enqueue_turn": False,
    }
    headers = {"Idempotency-Key": "retry-1"}
    first = api.post(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        json=payload,
        headers=headers,
    )
    second = api.post(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        json=payload,
        headers=headers,
    )
    assert first.status_code == 200
    assert second.status_code == 200
    assert (
        first.json()["message"]["message_id"] == second.json()["message"]["message_id"]
    )
    assert first.json()["turn_id"] == second.json()["turn_id"]
    listed = api.get(
        org_path(channel.tenant_id, f"/channels/{channel.channel_id}/messages"),
    )
    assert [item["message_id"] for item in listed.json()["messages"]] == [
        first.json()["message"]["message_id"]
    ]
    assert captured == []
    api.close()


@mock_aws
def test_dynamo_post_idempotency_survives_a_new_control_plane() -> None:
    table_name = "chatticus-post-idempotency-test"
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_messaging_table(client, table_name)
    store = DynamoMessagingStore(table_name, client=client)
    bot, channel = _channel_with_bot(ControlPlane(messaging_store=store), "Assistant")
    first = ControlPlane(messaging_store=store)
    _, started = first.post_channel_message(
        channel.channel_id,
        channel.tenant_id,
        ActorKind.HUMAN,
        "ryan",
        "hello",
        addressed_to_bot_id=bot.bot_id,
        enqueue_turn=False,
        idempotency_key="retry-1",
    )
    second = ControlPlane(messaging_store=store)
    message, again = second.post_channel_message(
        channel.channel_id,
        channel.tenant_id,
        ActorKind.HUMAN,
        "ryan",
        "hello",
        addressed_to_bot_id=bot.bot_id,
        enqueue_turn=False,
        idempotency_key="retry-1",
    )
    listed = second.list_channel_messages(channel.channel_id, channel.tenant_id)
    assert len(listed) == 1
    assert listed[0].message_id == message.message_id
    assert started is not None
    assert again is not None
    assert again.turn_id == started.turn_id


def test_http_channel_create_idempotency_key_does_not_duplicate() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    bot, _ = _channel_with_bot(plane, "Assistant")
    payload = {"user_id": "ryan", "bot_ids": [bot.bot_id]}
    headers = {"Idempotency-Key": "retry-1"}
    first = api.post(org_path("anthus", "/channels"), json=payload, headers=headers)
    second = api.post(org_path("anthus", "/channels"), json=payload, headers=headers)
    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["channel_id"] == second.json()["channel_id"]
    api.close()


def test_http_get_channel_roundtrip() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    bot, channel = _channel_with_bot(plane, "Assistant")
    fetched = api.get(
        org_path("anthus", f"/channels/{channel.channel_id}"),
    )
    assert fetched.status_code == 200
    payload = fetched.json()
    assert payload["channel_id"] == channel.channel_id
    assert payload["tenant_id"] == channel.tenant_id
    missing = api.get(
        org_path("other", f"/channels/{channel.channel_id}"),
    )
    assert missing.status_code == 404
    api.close()


@mock_aws
def test_http_get_channel_survives_a_new_control_plane_in_dynamo() -> None:
    table_name = "chatticus-channel-get-test"
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_messaging_table(client, table_name)
    store = DynamoMessagingStore(table_name, client=client)
    first_plane = ControlPlane(messaging_store=store)
    first_api = _client_for(first_plane)
    bot, channel = _channel_with_bot(first_plane, "Assistant")
    created = first_api.post(
        org_path("anthus", "/channels"),
        json={"user_id": "ryan", "bot_ids": [bot.bot_id]},
    )
    assert created.status_code == 200
    channel_id = created.json()["channel_id"]
    first_api.close()
    second_plane = ControlPlane(messaging_store=store)
    second_api = _client_for(second_plane)
    fetched = second_api.get(
        org_path("anthus", f"/channels/{channel_id}"),
    )
    assert fetched.status_code == 200
    assert fetched.json()["channel_id"] == channel_id
    second_api.close()


@mock_aws
def test_dynamo_channel_create_idempotency_survives_a_new_control_plane() -> None:
    table_name = "chatticus-channel-idempotency-test"
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_messaging_table(client, table_name)
    store = DynamoMessagingStore(table_name, client=client)
    bot = ControlPlane(messaging_store=store).create_bot(
        "anthus", "Assistant", creator_user_id="ryan"
    )
    first = ControlPlane(messaging_store=store)
    channel = first.create_channel(
        "anthus", "ryan", [bot.bot_id], idempotency_key="retry-ch"
    )
    second = ControlPlane(messaging_store=store)
    again = second.create_channel(
        "anthus", "ryan", [bot.bot_id], idempotency_key="retry-ch"
    )
    assert again.channel_id == channel.channel_id


def test_resume_does_not_publish_computer_job_to_cpu_queue() -> None:
    captured: list[TurnJob] = []
    plane = ControlPlane(turn_enqueued=captured.append)
    api = _client_for(plane)
    plane.set_computer_stopped("anthus", True)
    bot, channel = _channel_with_bot(plane, "Assistant")
    post = api.post(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "research this and open the household browser",
            "addressed_to_bot_id": bot.bot_id,
        },
    )
    turn_id = post.json()["turn_id"]
    ComputerlessWorker(
        plane,
        HttpTurnClient(api, channel.tenant_id),
        FakeTextCompletionClient(),
    ).complete_pending_for_bot(bot.bot_id)
    cpu_ids = {job.job_id for job in captured}
    assert cpu_ids
    plane.set_computer_stopped("anthus", False)
    resumed = api.post(
        org_path(channel.tenant_id, f"/turns/{turn_id}/resume"),
        headers=_worker_headers(api, worker_id="resume-worker"),
    )
    assert resumed.status_code == 200
    continuation = plane.job_for_turn(channel.tenant_id, turn_id)
    assert continuation is not None
    assert "computer" in continuation.required_capabilities
    assert continuation.job_id not in cpu_ids
    assert continuation.job_id not in {job.job_id for job in captured}
    api.close()


def test_resume_publishes_computer_job_to_computer_queue() -> None:
    cpu_jobs: list[TurnJob] = []
    computer_jobs: list[TurnJob] = []
    plane = ControlPlane(
        turn_enqueued=cpu_jobs.append,
        computer_enqueued=computer_jobs.append,
    )
    api = _client_for(plane)
    plane.set_computer_stopped("anthus", True)
    bot, channel = _channel_with_bot(plane, "Assistant")
    post = api.post(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "research this and open the household browser",
            "addressed_to_bot_id": bot.bot_id,
        },
    )
    turn_id = post.json()["turn_id"]
    ComputerlessWorker(
        plane,
        HttpTurnClient(api, channel.tenant_id),
        FakeTextCompletionClient(),
    ).complete_pending_for_bot(bot.bot_id)
    plane.set_computer_stopped("anthus", False)
    resumed = api.post(
        org_path(channel.tenant_id, f"/turns/{turn_id}/resume"),
        headers=_worker_headers(api, worker_id="resume-worker"),
    )
    assert resumed.status_code == 200
    continuation = plane.job_for_turn(channel.tenant_id, turn_id)
    assert continuation is not None
    assert "computer" in continuation.required_capabilities
    assert continuation.job_id not in {job.job_id for job in cpu_jobs}
    assert [job.job_id for job in computer_jobs] == [continuation.job_id]
    api.close()


def test_computerless_worker_refuses_a_computer_continuation_job() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    plane.set_computer_stopped("anthus", True)
    bot, channel = _channel_with_bot(plane, "Assistant")
    post = api.post(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "research this and open the household browser",
            "addressed_to_bot_id": bot.bot_id,
        },
    )
    turn_id = post.json()["turn_id"]
    counting = CountingTextCompletionClient()
    worker = ComputerlessWorker(
        plane,
        HttpTurnClient(api, channel.tenant_id),
        counting,
    )
    worker.complete_pending_for_bot(bot.bot_id)
    assert counting.calls == 1
    plane.set_computer_stopped("anthus", False)
    resumed = api.post(
        org_path(channel.tenant_id, f"/turns/{turn_id}/resume"),
        headers=_worker_headers(api, worker_id="resume-worker"),
    )
    assert resumed.status_code == 200
    job = plane.job_for_turn(channel.tenant_id, turn_id)
    assert job is not None
    assert "computer" in job.required_capabilities
    with pytest.raises(ComputerlessCannotExecuteComputerJob):
        worker.run_job(job)
    assert counting.calls == 1
    still = plane.job_for_turn(channel.tenant_id, turn_id)
    assert still is not None
    assert still.job_id == job.job_id
    assert "computer" in still.required_capabilities
    turn = plane.turn(channel.tenant_id, turn_id)
    assert turn.status == TurnStatus.ACTIVE
    assert turn.waiting_for == "browser"
    api.close()


def test_resume_without_a_wait_gate_is_refused() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    bot, channel = _channel_with_bot(plane)
    post = api.post(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "hello",
            "addressed_to_bot_id": bot.bot_id,
        },
    )
    turn_id = post.json()["turn_id"]
    refused = api.post(
        org_path(channel.tenant_id, f"/turns/{turn_id}/resume"),
        headers=_worker_headers(api, worker_id="resume-worker"),
    )
    assert refused.status_code == 409
    with pytest.raises(TurnNotWaitingError):
        plane.resume_waiting_turn(channel.tenant_id, turn_id)
    api.close()


def test_turn_completes_without_sse_watcher() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    bot, channel = _channel_with_bot(plane)
    post = api.post(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "hello",
            "addressed_to_bot_id": bot.bot_id,
        },
    )
    turn_id = post.json()["turn_id"]
    client = HttpTurnClient(api, channel.tenant_id)
    client.claim(turn_id, "test-worker")
    client.post_chunk(turn_id, "", complete=True)
    turn = plane.turn(channel.tenant_id, turn_id)
    assert turn.status == TurnStatus.COMPLETED
    api.close()


def test_bot_and_stopped_computer_survive_a_new_control_plane() -> None:
    store = InMemoryMessagingStore()
    first = ControlPlane(messaging_store=store)
    bot = first.create_bot("anthus", "Researcher", creator_user_id="ryan")
    first.set_computer_stopped("anthus", True)
    second = ControlPlane(messaging_store=store)
    channel = second.create_channel("anthus", "ryan", [bot.bot_id])
    assert second.computer_is_stopped("anthus")
    assert channel.participants[-1].actor_id == bot.bot_id


def test_duplicate_bot_name_survives_a_new_control_plane() -> None:
    store = InMemoryMessagingStore()
    first = ControlPlane(messaging_store=store)
    first.create_bot("anthus", "Researcher", creator_user_id="ryan")
    second = ControlPlane(messaging_store=store)
    with pytest.raises(DuplicateBotNameError):
        second.create_bot("anthus", "Researcher", creator_user_id="ryan")


@mock_aws
def test_dynamo_duplicate_bot_name_survives_a_new_control_plane() -> None:
    table_name = "chatticus-bot-name-test"
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_messaging_table(client, table_name)
    store = DynamoMessagingStore(table_name, client=client)
    first = ControlPlane(messaging_store=store)
    first.create_bot("anthus", "Researcher", creator_user_id="ryan")
    second = ControlPlane(messaging_store=store)
    with pytest.raises(DuplicateBotNameError):
        second.create_bot("anthus", "Researcher", creator_user_id="ryan")


def test_http_duplicate_bot_name_is_rejected() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    created = api.post(
        org_path("anthus", "/bots"),
        json={"name": "Researcher"},
    )
    assert created.status_code == 200
    duplicate = api.post(
        org_path("anthus", "/bots"),
        json={"name": "Researcher"},
    )
    assert duplicate.status_code == 400
    api.close()


def test_http_bot_create_idempotency_key_does_not_duplicate() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    payload = {"user_id": "ryan", "name": "Researcher"}
    headers = {"Idempotency-Key": "retry-1"}
    first = api.post(org_path("anthus", "/bots"), json=payload, headers=headers)
    second = api.post(org_path("anthus", "/bots"), json=payload, headers=headers)
    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["bot_id"] == second.json()["bot_id"]
    duplicate = api.post(
        org_path("anthus", "/bots"),
        json=payload,
    )
    assert duplicate.status_code == 400
    api.close()


@mock_aws
def test_dynamo_bot_create_idempotency_survives_a_new_control_plane() -> None:
    table_name = "chatticus-bot-idempotency-test"
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_messaging_table(client, table_name)
    store = DynamoMessagingStore(table_name, client=client)
    first = ControlPlane(messaging_store=store)
    bot = first.create_bot(
        "anthus", "Researcher", creator_user_id="ryan", idempotency_key="retry-bot"
    )
    second = ControlPlane(messaging_store=store)
    again = second.create_bot(
        "anthus", "Researcher", creator_user_id="ryan", idempotency_key="retry-bot"
    )
    assert again.bot_id == bot.bot_id


def test_channel_messages_survive_a_new_control_plane() -> None:
    store = InMemoryMessagingStore()
    first = ControlPlane(messaging_store=store)
    bot, channel = _channel_with_bot(first)
    first.post_channel_message(
        channel.channel_id,
        channel.tenant_id,
        ActorKind.HUMAN,
        "ryan",
        "hello",
        addressed_to_bot_id=bot.bot_id,
        enqueue_turn=False,
    )
    second = ControlPlane(messaging_store=store)
    messages = second.list_channel_messages(channel.channel_id, channel.tenant_id)
    assert len(messages) == 1
    assert messages[0].body == "hello"


def test_duplicate_delivery_calls_the_model_once() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    bot, channel = _channel_with_bot(plane, "Assistant")
    api.post(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "ping",
            "addressed_to_bot_id": bot.bot_id,
        },
    )
    job = plane.pending_jobs_for_bot(bot.bot_id)[0]
    other = replace(job, job_id=str(uuid4()))
    counting = CountingTextCompletionClient()
    ComputerlessWorker(plane, HttpTurnClient(api, channel.tenant_id), counting).run_job(
        job
    )
    ComputerlessWorker(plane, HttpTurnClient(api, channel.tenant_id), counting).run_job(
        other
    )
    assert counting.calls == 1
    api.close()


def test_stale_attempt_cannot_append_after_reassignment() -> None:
    plane = ControlPlane(attempt_lease=timedelta(seconds=60))
    api = _client_for(plane)
    bot, channel = _channel_with_bot(plane, "Assistant")
    post = api.post(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "ping",
            "addressed_to_bot_id": bot.bot_id,
        },
    )
    turn_id = post.json()["turn_id"]
    first = plane.claim_turn_attempt(channel.tenant_id, turn_id, "worker-a")
    assert first is not None and first.acquired
    plane.advance_seconds(61)
    second = plane.claim_turn_attempt(channel.tenant_id, turn_id, "worker-b")
    assert second is not None and second.acquired
    assert second.fence_token != first.fence_token
    with pytest.raises(StaleAttemptError):
        plane.post_turn_chunk(
            turn_id, channel.tenant_id, "late", fence_token=first.fence_token
        )
    plane.post_turn_chunk(
        turn_id,
        channel.tenant_id,
        "ok",
        complete=True,
        fence_token=second.fence_token,
    )
    turn = plane.turn(channel.tenant_id, turn_id)
    assert turn.status == TurnStatus.COMPLETED
    api.close()


def test_complete_turn_second_message_uses_chunks_not_prior_greeting() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    bot, channel = _channel_with_bot(plane, "Assistant")
    worker = ComputerlessWorker(
        plane,
        HttpTurnClient(api, channel.tenant_id),
        FakeTextCompletionClient(),
    )
    first_post = api.post(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "hello",
            "addressed_to_bot_id": bot.bot_id,
        },
    )
    worker.complete_pending_for_bot(bot.bot_id)
    second_post = api.post(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "what is two plus two",
            "addressed_to_bot_id": bot.bot_id,
        },
    )
    second_turn_id = second_post.json()["turn_id"]
    worker.complete_pending_for_bot(bot.bot_id)
    chunks = plane._messaging_store.list_turn_chunks(channel.tenant_id, second_turn_id)
    messages = plane.list_channel_messages(channel.channel_id, channel.tenant_id)
    bot_messages = [
        message for message in messages if message.author_kind == ActorKind.BOT
    ]
    assert len(bot_messages) == 2
    assert bot_messages[-1].body == "".join(chunks)
    assert bot_messages[-1].body != bot_messages[0].body
    assert first_post.json()["turn_id"] != second_turn_id
    api.close()


def test_complete_turn_idempotent_after_completion_append() -> None:
    from chatticus.models import Message

    plane = ControlPlane()
    api = _client_for(plane)
    bot, channel = _channel_with_bot(plane, "Assistant")
    post = api.post(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "hello",
            "addressed_to_bot_id": bot.bot_id,
        },
    )
    turn_id = post.json()["turn_id"]
    turn_client = HttpTurnClient(api, channel.tenant_id)
    turn_client.claim(turn_id, "worker-a")
    turn_client.post_chunk(turn_id, "Answer one.")
    turn = plane.turn(channel.tenant_id, turn_id)
    body = plane._joined_turn_body(turn)
    channel_record = plane.channel(channel.tenant_id, channel.channel_id)
    message = Message(
        message_id=str(uuid4()),
        channel_id=channel.channel_id,
        tenant_id=channel.tenant_id,
        seq=channel_record.next_seq,
        author_kind=ActorKind.BOT,
        author_id=bot.bot_id,
        body=body,
        addressed_to_bot_id=None,
        created_at=plane._now,
    )
    channel_record.next_seq += 1
    plane._messaging_store.put_channel(channel_record)
    plane._messaging_store.put_message(message)
    completed = plane._complete_turn(turn, expected_fence=turn.fence_token)
    assert completed.body == "Answer one."
    bot_messages = [
        row
        for row in plane.list_channel_messages(channel.channel_id, channel.tenant_id)
        if row.author_kind == ActorKind.BOT
    ]
    assert len(bot_messages) == 1
    assert plane.turn(channel.tenant_id, turn_id).status == TurnStatus.COMPLETED
    api.close()


def test_complete_turn_completed_turn_uses_event_message_seq() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    bot, channel = _channel_with_bot(plane, "Assistant")
    post = api.post(
        org_path("anthus", f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "hello",
            "addressed_to_bot_id": bot.bot_id,
        },
    )
    turn_id = post.json()["turn_id"]
    turn_client = HttpTurnClient(api, channel.tenant_id)
    turn_client.claim(turn_id, "worker-a")
    turn_client.post_chunk(turn_id, "Answer one.", complete=True)
    turn = plane.turn(channel.tenant_id, turn_id)
    events = plane.list_turn_events(channel.tenant_id, turn_id)
    completed_event = events[-1]
    assert completed_event.kind == TurnEventKind.TURN_COMPLETED
    assert completed_event.message_seq is not None
    message = plane._complete_turn(turn)
    assert message.seq == completed_event.message_seq
    api.close()
