"""Kernel and HTTP tests for channels, turns, and the computerless worker."""

from __future__ import annotations

import json
import os
from dataclasses import replace
from datetime import timedelta
from uuid import uuid4

import boto3
import pytest
from moto import mock_aws

from chatticus.control_plane import ControlPlane
from chatticus.http.app import create_app
from chatticus.http.client import HttpTurnClient
from chatticus.http.test_server import start_test_server
from chatticus.messaging.store import (
    DynamoMessagingStore,
    InMemoryMessagingStore,
    create_messaging_table,
)
from chatticus.models import (
    ActorKind,
    ComputerlessCannotExecuteComputerJob,
    ComputerNotReadyError,
    StaleAttemptError,
    TurnEventKind,
    TurnJob,
    TurnNotWaitingError,
    TurnStatus,
)
from chatticus.turn_recovery import logical_enqueue_id
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
    bot = plane.create_bot("anthus", "ryan", name)
    channel = plane.create_channel("anthus", "ryan", [bot.bot_id])
    return bot, channel


def _client_for(plane: ControlPlane):
    return start_test_server(create_app(plane))


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
    bot = first.create_bot("anthus", "ryan", "Assistant")
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
    turn_client.claim(turn_id, "test-worker")
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


def test_computerless_worker_waits_when_the_model_needs_the_browser() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    plane.set_computer_stopped("anthus", "ryan", True)
    bot, channel = _channel_with_bot(plane, "Assistant")
    post = api.post(
        f"/channels/{channel.channel_id}/messages",
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "research this and open the household browser",
            "addressed_to_bot_id": bot.bot_id,
        },
        headers={"X-Tenant-Id": channel.tenant_id},
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
        f"/channels/{channel.channel_id}/messages",
        headers={"X-Tenant-Id": channel.tenant_id},
    ).json()["messages"]
    bot_messages = [m for m in messages if m["author_kind"] == ActorKind.BOT]
    assert bot_messages == []
    api.close()


def test_computerless_worker_does_not_recall_model_on_a_waiting_turn() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    plane.set_computer_stopped("anthus", "ryan", True)
    bot, channel = _channel_with_bot(plane, "Assistant")
    post = api.post(
        f"/channels/{channel.channel_id}/messages",
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "research this and open the household browser",
            "addressed_to_bot_id": bot.bot_id,
        },
        headers={"X-Tenant-Id": channel.tenant_id},
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
            user_id=channel.user_id,
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
    turn_client.claim(turn_id, "test-worker")
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


def test_http_waiting_emits_gate_and_releases_claim() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    bot, channel = _channel_with_bot(plane)
    post = api.post(
        f"/channels/{channel.channel_id}/messages",
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "open the household browser",
            "addressed_to_bot_id": bot.bot_id,
        },
        headers={"X-Tenant-Id": channel.tenant_id},
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
        f"/turns/{turn_id}/waiting",
        json={"gate": "browser", "fence_token": claimed["fence_token"]},
        headers={"X-Tenant-Id": channel.tenant_id},
    )
    assert stale.status_code == 409
    plane.set_computer_stopped("anthus", "ryan", True)
    refused = api.post(
        f"/turns/{turn_id}/resume",
        headers={"X-Tenant-Id": channel.tenant_id},
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
        f"/channels/{channel.channel_id}/messages",
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "open the household browser",
            "addressed_to_bot_id": bot.bot_id,
        },
        headers={"X-Tenant-Id": channel.tenant_id},
    )
    turn_id = post.json()["turn_id"]
    client = HttpTurnClient(api, channel.tenant_id)
    client.claim(turn_id, "waiting-worker")
    client.post_chunk(turn_id, "Here is a draft.")
    client.post_waiting(turn_id, "browser")
    response = api.get(
        f"/turns/{turn_id}",
        headers={"X-Tenant-Id": channel.tenant_id},
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
        f"/turns/{turn_id}",
        headers={"X-Tenant-Id": channel.tenant_id},
    )
    assert second.json()["pending_computer_tool"]["action_id"] == pending["action_id"]
    events = plane.list_turn_events(channel.tenant_id, turn_id)
    waiting = [event for event in events if event.kind == TurnEventKind.TURN_WAITING]
    assert waiting[0].pending_computer_tool is not None
    assert waiting[0].pending_computer_tool.action_id == pending["action_id"]
    denied = api.get(
        f"/turns/{turn_id}",
        headers={"X-Tenant-Id": "other"},
    )
    assert denied.status_code == 403
    api.close()


def test_resume_enqueues_the_same_turn_when_the_computer_is_running() -> None:
    plane = ControlPlane()
    api = _client_for(plane)
    bot, channel = _channel_with_bot(plane)
    post = api.post(
        f"/channels/{channel.channel_id}/messages",
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "open the household browser",
            "addressed_to_bot_id": bot.bot_id,
        },
        headers={"X-Tenant-Id": channel.tenant_id},
    )
    turn_id = post.json()["turn_id"]
    client = HttpTurnClient(api, channel.tenant_id)
    client.claim(turn_id, "waiting-worker")
    client.post_chunk(turn_id, "Here is a draft.")
    client.post_waiting(turn_id, "browser")
    plane.set_computer_stopped("anthus", "ryan", False)
    resumed = api.post(
        f"/turns/{turn_id}/resume",
        headers={"X-Tenant-Id": channel.tenant_id},
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
        f"/channels/{channel.channel_id}/messages",
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "Fence probe; do not wait on this turn.",
            "addressed_to_bot_id": bot.bot_id,
            "enqueue_turn": False,
        },
        headers={"X-Tenant-Id": channel.tenant_id},
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
        f"/turns/{turn_id}/claim",
        json={"worker_id": "exercise-fence-a"},
        headers={"X-Tenant-Id": channel.tenant_id},
    )
    second = api.post(
        f"/turns/{turn_id}/claim",
        json={"worker_id": "exercise-fence-b"},
        headers={"X-Tenant-Id": channel.tenant_id},
    )
    assert first.status_code == 200
    assert first.json().get("acquired") is True
    assert second.status_code == 409
    api.close()


def test_resume_does_not_publish_computer_job_to_cpu_queue() -> None:
    captured: list[TurnJob] = []
    plane = ControlPlane(turn_enqueued=captured.append)
    api = _client_for(plane)
    plane.set_computer_stopped("anthus", "ryan", True)
    bot, channel = _channel_with_bot(plane, "Assistant")
    post = api.post(
        f"/channels/{channel.channel_id}/messages",
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "research this and open the household browser",
            "addressed_to_bot_id": bot.bot_id,
        },
        headers={"X-Tenant-Id": channel.tenant_id},
    )
    turn_id = post.json()["turn_id"]
    ComputerlessWorker(
        plane,
        HttpTurnClient(api, channel.tenant_id),
        FakeTextCompletionClient(),
    ).complete_pending_for_bot(bot.bot_id)
    cpu_ids = {job.job_id for job in captured}
    assert cpu_ids
    plane.set_computer_stopped("anthus", "ryan", False)
    resumed = api.post(
        f"/turns/{turn_id}/resume",
        headers={"X-Tenant-Id": channel.tenant_id},
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
    plane.set_computer_stopped("anthus", "ryan", True)
    bot, channel = _channel_with_bot(plane, "Assistant")
    post = api.post(
        f"/channels/{channel.channel_id}/messages",
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "research this and open the household browser",
            "addressed_to_bot_id": bot.bot_id,
        },
        headers={"X-Tenant-Id": channel.tenant_id},
    )
    turn_id = post.json()["turn_id"]
    ComputerlessWorker(
        plane,
        HttpTurnClient(api, channel.tenant_id),
        FakeTextCompletionClient(),
    ).complete_pending_for_bot(bot.bot_id)
    plane.set_computer_stopped("anthus", "ryan", False)
    resumed = api.post(
        f"/turns/{turn_id}/resume",
        headers={"X-Tenant-Id": channel.tenant_id},
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
    plane.set_computer_stopped("anthus", "ryan", True)
    bot, channel = _channel_with_bot(plane, "Assistant")
    post = api.post(
        f"/channels/{channel.channel_id}/messages",
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "research this and open the household browser",
            "addressed_to_bot_id": bot.bot_id,
        },
        headers={"X-Tenant-Id": channel.tenant_id},
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
    plane.set_computer_stopped("anthus", "ryan", False)
    resumed = api.post(
        f"/turns/{turn_id}/resume",
        headers={"X-Tenant-Id": channel.tenant_id},
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
    refused = api.post(
        f"/turns/{turn_id}/resume",
        headers={"X-Tenant-Id": channel.tenant_id},
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
    client = HttpTurnClient(api, channel.tenant_id)
    client.claim(turn_id, "test-worker")
    client.post_chunk(turn_id, "", complete=True)
    turn = plane.turn(channel.tenant_id, turn_id)
    assert turn.status == TurnStatus.COMPLETED
    api.close()


def test_bot_and_stopped_computer_survive_a_new_control_plane() -> None:
    store = InMemoryMessagingStore()
    first = ControlPlane(messaging_store=store)
    bot = first.create_bot("anthus", "ryan", "Researcher")
    first.set_computer_stopped("anthus", "ryan", True)
    second = ControlPlane(messaging_store=store)
    channel = second.create_channel("anthus", "ryan", [bot.bot_id])
    assert second.computer_is_stopped("anthus", "ryan")
    assert channel.participants[-1].actor_id == bot.bot_id


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
        f"/channels/{channel.channel_id}/messages",
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "ping",
            "addressed_to_bot_id": bot.bot_id,
        },
        headers={"X-Tenant-Id": channel.tenant_id},
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
        f"/channels/{channel.channel_id}/messages",
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "ping",
            "addressed_to_bot_id": bot.bot_id,
        },
        headers={"X-Tenant-Id": channel.tenant_id},
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
