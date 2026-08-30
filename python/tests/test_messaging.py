"""Kernel and HTTP tests for channels, turns, and the computerless worker."""

from __future__ import annotations

import json
import os

import boto3
import pytest
from moto import mock_aws

from chatticus.control_plane import ControlPlane
from chatticus.http.app import create_app
from chatticus.http.client import HttpTurnClient
from chatticus.http.test_server import start_test_server
from chatticus.messaging.store import (
    DynamoMessagingStore,
    create_messaging_table,
)
from chatticus.models import (
    ActorKind,
    TurnEventKind,
    TurnStatus,
)
from chatticus.worker.computerless import ComputerlessWorker, FakeTextCompletionClient
from chatticus.worker.openai_completion import (
    OpenAITextCompletionClient,
    completion_client_from_env,
    load_local_env,
)


def _channel_with_bot(plane: ControlPlane, name: str = "Researcher"):
    bot = plane.create_bot("anthus", "ryan", name)
    channel = plane.create_channel("anthus", "ryan", [bot.bot_id])
    return bot, channel


def _client_for(plane: ControlPlane):
    return start_test_server(create_app(plane))


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
        f"/channels/{channel.channel_id}/messages",
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "hello",
            "addressed_to_bot_id": bot.bot_id,
        },
        headers={"X-Tenant-Id": channel.tenant_id},
    )
    assert response.status_code == 200
    turn_id = response.json()["turn_id"]
    assert turn_id is not None
    jobs = plane.pending_jobs_for_bot(bot.bot_id)
    assert jobs[0].required_capabilities == frozenset({"cpu"})
    turn_client = HttpTurnClient(api, channel.tenant_id)
    turn_client.post_chunk(turn_id, "Hel")
    turn_client.post_chunk(turn_id, "", complete=True)
    messages = api.get(
        f"/channels/{channel.channel_id}/messages",
        headers={"X-Tenant-Id": channel.tenant_id},
    ).json()["messages"]
    assert len(messages) == 2
    events = store.list_turn_events(channel.tenant_id, turn_id)
    assert events[0].kind == TurnEventKind.TURN_STARTED
    assert events[-1].kind == TurnEventKind.TURN_COMPLETED
    api.close()


def test_cross_tenant_channel_post_is_rejected() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    _, channel = _channel_with_bot(plane)
    response = api.post(
        f"/channels/{channel.channel_id}/messages",
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "alex",
            "body": "hello",
        },
        headers={"X-Tenant-Id": "other"},
    )
    assert response.status_code == 403
    api.close()


def test_cpu_turn_does_not_pin_computer() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    bot, channel = _channel_with_bot(plane)
    api.post(
        f"/channels/{channel.channel_id}/messages",
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "hello",
            "addressed_to_bot_id": bot.bot_id,
        },
        headers={"X-Tenant-Id": channel.tenant_id},
    )
    jobs = plane.pending_jobs_for_bot(bot.bot_id)
    assert jobs[0].computer_id is None
    api.close()


def test_computerless_worker_commits_one_answer_with_fake_openai() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    plane.set_computer_stopped("anthus", "ryan", True)
    bot, channel = _channel_with_bot(plane, "Assistant")
    api.post(
        f"/channels/{channel.channel_id}/messages",
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "ping",
            "addressed_to_bot_id": bot.bot_id,
        },
        headers={"X-Tenant-Id": channel.tenant_id},
    )
    worker = ComputerlessWorker(
        plane,
        HttpTurnClient(api, channel.tenant_id),
        FakeTextCompletionClient(),
    )
    worker.complete_pending_for_bot(bot.bot_id)
    assert plane.computer_is_stopped("anthus", "ryan")
    messages = api.get(
        f"/channels/{channel.channel_id}/messages",
        headers={"X-Tenant-Id": channel.tenant_id},
    ).json()["messages"]
    bot_messages = [m for m in messages if m["author_kind"] == ActorKind.BOT]
    assert len(bot_messages) == 1
    assert "You said: ping" in bot_messages[0]["body"]
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
    plane.set_computer_stopped("anthus", "ryan", True)
    bot, channel = _channel_with_bot(plane, "Assistant")
    post = api.post(
        f"/channels/{channel.channel_id}/messages",
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "Reply with a short greeting.",
            "addressed_to_bot_id": bot.bot_id,
        },
        headers={"X-Tenant-Id": channel.tenant_id},
    )
    turn_id = post.json()["turn_id"]
    assert turn_id is not None
    worker = ComputerlessWorker(
        plane,
        HttpTurnClient(api, channel.tenant_id),
        OpenAITextCompletionClient(api_key, model),
    )
    worker.complete_pending_for_bot(bot.bot_id)
    assert plane.computer_is_stopped("anthus", "ryan")
    turn = plane.turn(channel.tenant_id, turn_id)
    assert turn.status == TurnStatus.COMPLETED
    messages = api.get(
        f"/channels/{channel.channel_id}/messages",
        headers={"X-Tenant-Id": channel.tenant_id},
    ).json()["messages"]
    bot_messages = [m for m in messages if m["author_kind"] == ActorKind.BOT]
    assert len(bot_messages) == 1
    assert bot_messages[0]["body"].strip()
    events: list[dict[str, object]] = []
    with api.stream(
        "GET",
        f"/turns/{turn_id}/stream",
        headers={"X-Tenant-Id": channel.tenant_id},
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


def test_http_sse_replay_after_cursor() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    bot, channel = _channel_with_bot(plane)
    post = api.post(
        f"/channels/{channel.channel_id}/messages",
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "hello",
            "addressed_to_bot_id": bot.bot_id,
        },
        headers={"X-Tenant-Id": channel.tenant_id},
    )
    turn_id = post.json()["turn_id"]
    turn_client = HttpTurnClient(api, channel.tenant_id)
    turn_client.post_chunk(turn_id, "Hel")
    turn_client.post_chunk(turn_id, "lo")
    turn_client.post_chunk(turn_id, "!")
    turn_client.post_chunk(turn_id, "", complete=True)
    events: list[dict[str, object]] = []
    with api.stream(
        "GET",
        f"/turns/{turn_id}/stream",
        headers={"X-Tenant-Id": channel.tenant_id},
        params={"after_seq": 2},
    ) as response:
        buffer = ""
        for chunk in response.iter_bytes():
            buffer += chunk.decode()
            while "\n\n" in buffer:
                frame, buffer = buffer.split("\n\n", 1)
                for line in frame.split("\n"):
                    if line.startswith("data:"):
                        events.append(json.loads(line[5:].strip()))
                    if len(events) >= 2:
                        break
            if len(events) >= 2:
                break
    replayed = [event["seq"] for event in events[:2]]
    assert replayed == [3, 4]
    api.close()


def test_http_cross_tenant_turn_stream_is_denied() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    bot, channel = _channel_with_bot(plane)
    post = api.post(
        f"/channels/{channel.channel_id}/messages",
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "hello",
            "addressed_to_bot_id": bot.bot_id,
        },
        headers={"X-Tenant-Id": channel.tenant_id},
    )
    turn_id = post.json()["turn_id"]
    response = api.get(
        f"/turns/{turn_id}/stream",
        headers={"X-Tenant-Id": "other"},
    )
    assert response.status_code == 403
    api.close()


def test_turn_completes_without_sse_watcher() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    bot, channel = _channel_with_bot(plane)
    post = api.post(
        f"/channels/{channel.channel_id}/messages",
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "hello",
            "addressed_to_bot_id": bot.bot_id,
        },
        headers={"X-Tenant-Id": channel.tenant_id},
    )
    turn_id = post.json()["turn_id"]
    HttpTurnClient(api, channel.tenant_id).post_chunk(turn_id, "", complete=True)
    turn = plane.turn(channel.tenant_id, turn_id)
    assert turn.status == TurnStatus.COMPLETED
    api.close()
