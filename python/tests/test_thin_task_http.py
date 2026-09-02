"""HTTP and worker wiring for the thin Task tool."""

from __future__ import annotations

from chatticus.control_plane import ControlPlane
from chatticus.http.client import HttpTurnClient
from chatticus.http.paths import org_path
from chatticus.models import ActorKind, TaskStatus
from chatticus.worker.computerless import (
    ComputerlessWorker,
    TaskAwareFakeTextCompletionClient,
)
from chatticus.worker.openai_completion import (
    WORKER_SYSTEM_PROMPT,
    computerless_worker_tools,
    outcome_from_chat_completion,
)
from conftest import make_test_api, register_worker_headers


def _channel_with_bot(plane: ControlPlane, name: str = "Assistant"):
    bot = plane.create_bot("anthus", name, creator_user_id="ryan")
    channel = plane.create_channel("anthus", "ryan", [bot.bot_id])
    return bot, channel


def test_computerless_worker_tools_include_task_and_computer_gate() -> None:
    names = {tool["function"]["name"] for tool in computerless_worker_tools()}
    assert names == {
        "task",
        "read_workspace",
        "browse",
        "request_computer_capability",
    }
    assert "task tool" in WORKER_SYSTEM_PROMPT


def test_outcome_from_chat_completion_reads_task_tool_call() -> None:
    outcome = outcome_from_chat_completion(
        {
            "choices": [
                {
                    "message": {
                        "content": "I'll track that.",
                        "tool_calls": [
                            {
                                "function": {
                                    "name": "task",
                                    "arguments": (
                                        '{"action": "create", "title": "Pay bill"}'
                                    ),
                                }
                            }
                        ],
                    }
                }
            ]
        },
        model="chatticus-test-model",
    )
    assert outcome.task_tool_call is not None
    assert outcome.task_tool_call.action == "create"
    assert outcome.task_tool_call.arguments == {"title": "Pay bill"}


def test_http_task_tool_create_is_tenant_scoped() -> None:
    plane, api = make_test_api()
    bot = plane.create_bot("anthus", "Assistant", creator_user_id="ryan")
    response = api.post(
        org_path("anthus", f"/bots/{bot.bot_id}/tasks/tool"),
        json={
            "user_id": "ryan",
            "action": "create",
            "arguments": {"title": "Pay the electric bill"},
        },
        headers=register_worker_headers(api, "anthus"),
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == TaskStatus.OPEN
    assert payload["created_by_bot_id"] == bot.bot_id
    api.close()


def test_http_task_tool_rejects_other_tenant() -> None:
    plane, api = make_test_api()
    bot = plane.create_bot("anthus", "Assistant", creator_user_id="ryan")
    response = api.post(
        org_path("other-household", f"/bots/{bot.bot_id}/tasks/tool"),
        json={
            "user_id": "ryan",
            "action": "create",
            "arguments": {"title": "sneaky task"},
        },
        headers=register_worker_headers(api, "other-household", "other-worker"),
    )
    assert response.status_code == 404
    api.close()


def test_http_list_user_tasks_is_tenant_scoped() -> None:
    plane, api = make_test_api()
    bot = plane.create_bot("anthus", "Assistant", creator_user_id="ryan")
    worker_headers = register_worker_headers(api, "anthus")
    created = api.post(
        org_path("anthus", f"/bots/{bot.bot_id}/tasks/tool"),
        json={
            "user_id": "ryan",
            "action": "create",
            "arguments": {"title": "Pay the electric bill"},
        },
        headers=worker_headers,
    )
    assert created.status_code == 200
    listed = api.get(
        org_path("anthus", "/users/ryan/tasks"),
    )
    assert listed.status_code == 200
    tasks = listed.json()["tasks"]
    assert len(tasks) == 1
    assert tasks[0]["task_id"] == created.json()["task_id"]
    assert tasks[0]["title"] == "Pay the electric bill"
    empty = api.get(
        org_path("other-household", "/users/ryan/tasks"),
    )
    assert empty.status_code == 200
    assert empty.json()["tasks"] == []
    api.close()


def test_http_get_task_is_tenant_scoped() -> None:
    plane, api = make_test_api()
    bot = plane.create_bot("anthus", "Assistant", creator_user_id="ryan")
    created = api.post(
        org_path("anthus", f"/bots/{bot.bot_id}/tasks/tool"),
        json={
            "user_id": "ryan",
            "action": "create",
            "arguments": {"title": "Pay the electric bill"},
        },
        headers=register_worker_headers(api, "anthus"),
    )
    task_id = created.json()["task_id"]
    fetched = api.get(
        org_path("anthus", f"/tasks/{task_id}"),
    )
    assert fetched.status_code == 200
    assert fetched.json()["task_id"] == task_id
    denied = api.get(
        org_path("other-household", f"/tasks/{task_id}"),
    )
    assert denied.status_code == 404
    api.close()


def test_computerless_worker_creates_task_via_http_tool_call() -> None:
    plane, api = make_test_api()
    plane.set_computer_stopped("anthus", True)
    bot, channel = _channel_with_bot(plane, "Assistant")
    api.post(
        org_path(channel.tenant_id, f"/channels/{channel.channel_id}/messages"),
        json={
            "author_kind": ActorKind.HUMAN,
            "author_id": "ryan",
            "body": "please create a task titled Pay the electric bill",
            "addressed_to_bot_id": bot.bot_id,
        },
    )
    worker = ComputerlessWorker(
        plane,
        HttpTurnClient(api, channel.tenant_id),
        TaskAwareFakeTextCompletionClient(),
    )
    worker.complete_pending_for_bot(bot.bot_id)
    tasks = plane.list_tasks("anthus", "ryan")
    assert len(tasks) == 1
    assert tasks[0].title == "Pay the electric bill"
    assert tasks[0].status == TaskStatus.OPEN
    assert plane.pending_jobs() == []
    api.close()
