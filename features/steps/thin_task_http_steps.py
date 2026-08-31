"""Behave steps for thin Task HTTP and computerless worker wiring."""

from __future__ import annotations

from behave import then, when

from chatticus.http.app import create_app
from chatticus.http.test_server import start_test_server
from chatticus.thin_task import ThinTaskDriver


@when(
    'tenant "{tenant_id}" posts the task tool create action for bot "{bot_name}" '
    'with title "{title}"'
)
def when_http_task_create(
    context: object, tenant_id: str, bot_name: str, title: str
) -> None:
    if not hasattr(context, "api_client"):
        context.api_client = start_test_server(create_app(context.plane))
    bot = context.bots_by_name[bot_name]
    context.user_id = bot.user_id
    context.tenant_id = bot.tenant_id
    response = context.api_client.post(
        f"/bots/{bot.bot_id}/tasks/tool",
        json={
            "user_id": bot.user_id,
            "action": "create",
            "arguments": {"title": title},
        },
        headers={"X-Tenant-Id": tenant_id},
    )
    context.http_response = response
    if response.status_code < 400:
        context.http_task = response.json()


@then('the HTTP task response has status "{status}"')
def then_http_task_status(context: object, status: str) -> None:
    assert context.http_response.status_code == 200
    assert context.http_task["status"] == status


@then('the HTTP task response records bot "{bot_name}" as provenance')
def then_http_task_provenance(context: object, bot_name: str) -> None:
    bot = context.plane.bot_by_name(context.tenant_id, context.user_id, bot_name)
    assert context.http_task["created_by_bot_id"] == bot.bot_id


@then("the HTTP task tool call is denied for tenant isolation")
def then_http_task_denied(context: object) -> None:
    assert context.http_response.status_code in {403, 404}


@then('tenant "{tenant_id}" can list tasks for user "{user_id}":')
def then_list_user_tasks(context: object, tenant_id: str, user_id: str) -> None:
    if not hasattr(context, "api_client"):
        context.api_client = start_test_server(create_app(context.plane))
    task_ids: list[str] = getattr(context, "http_task_ids", [])
    if not task_ids and hasattr(context, "http_task"):
        task_ids = [context.http_task["task_id"]]

    def resolve_cell(cell: str) -> str:
        value = cell.strip()
        if value.isdigit():
            return task_ids[int(value) - 1]
        return value

    expected_ids: list[str] = []
    if context.table.headings and context.table.headings[0].strip():
        expected_ids.append(resolve_cell(context.table.headings[0]))
    expected_ids.extend(resolve_cell(row.cells[0]) for row in context.table)
    expected_ids = [task_id for task_id in expected_ids if task_id]
    response = context.api_client.get(
        f"/users/{user_id}/tasks",
        headers={"X-Tenant-Id": tenant_id},
    )
    assert response.status_code == 200
    listed_ids = [task["task_id"] for task in response.json()["tasks"]]
    assert listed_ids == sorted(expected_ids)
    for task_id in expected_ids:
        payload = next(
            task for task in response.json()["tasks"] if task["task_id"] == task_id
        )
        assert payload["tenant_id"] == tenant_id
        assert payload["user_id"] == user_id


@then('another tenant cannot list tasks for user "{user_id}"')
def then_other_tenant_cannot_list_tasks(context: object, user_id: str) -> None:
    response = context.api_client.get(
        f"/users/{user_id}/tasks",
        headers={"X-Tenant-Id": "other-household"},
    )
    assert response.status_code == 200
    assert response.json()["tasks"] == []


@then('tenant "{tenant_id}" can read the HTTP task by identifier')
def then_read_http_task(context: object, tenant_id: str) -> None:
    response = context.api_client.get(
        f"/tasks/{context.http_task['task_id']}",
        headers={"X-Tenant-Id": tenant_id},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["task_id"] == context.http_task["task_id"]
    assert payload["tenant_id"] == tenant_id


@then("another tenant cannot read the HTTP task by identifier")
def then_other_tenant_cannot_read_http_task(context: object) -> None:
    response = context.api_client.get(
        f"/tasks/{context.http_task['task_id']}",
        headers={"X-Tenant-Id": "other-household"},
    )
    assert response.status_code == 404


@when('bot "{bot_name}" receives "{message}"')
def when_bot_receives_message(context: object, bot_name: str, message: str) -> None:
    bot = context.bots_by_name[bot_name]
    if not hasattr(context, "task_driver"):
        context.task_driver = ThinTaskDriver(
            context.plane, tenant_id=bot.tenant_id, user_id=bot.user_id
        )
    channel = context.plane.create_channel(bot.tenant_id, bot.user_id, [bot.bot_id])
    context.plane.post_channel_message(
        channel.channel_id,
        bot.tenant_id,
        author_kind="human",
        author_id=bot.user_id,
        body=message,
        addressed_to_bot_id=bot.bot_id,
    )
    context.worker_bot_id = bot.bot_id


@when('bot "{bot_name}" runs one task-aware computerless worker turn')
def when_bot_runs_task_aware_worker_turn(context: object, bot_name: str) -> None:
    from chatticus.http.client import HttpTurnClient
    from chatticus.worker.computerless import (
        ComputerlessWorker,
        TaskAwareFakeTextCompletionClient,
    )

    bot = context.bots_by_name[bot_name]
    if not hasattr(context, "api_client"):
        context.api_client = start_test_server(create_app(context.plane))
    worker = ComputerlessWorker(
        context.plane,
        HttpTurnClient(context.api_client, bot.tenant_id),
        TaskAwareFakeTextCompletionClient(),
    )
    worker.complete_pending_for_bot(bot.bot_id)
    tasks = context.plane.list_tasks(bot.tenant_id, bot.user_id)
    context.last_task = tasks[-1] if tasks else None
