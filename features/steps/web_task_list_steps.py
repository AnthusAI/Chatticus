"""Step definitions for the household task list web UI API contract."""

from __future__ import annotations

from behave import then, when
from sse_helpers import tenant_headers


@when('the web UI requests the task list for tenant "{tenant_id}" user "{user_id}"')
def when_web_ui_requests_task_list(
    context: object, tenant_id: str, user_id: str
) -> None:
    response = context.api_client.get(
        f"/users/{user_id}/tasks",
        headers=tenant_headers(tenant_id),
    )
    context.web_ui_task_list_response = response
    if response.status_code == 200:
        context.web_ui_task_titles = [
            task["title"] for task in response.json()["tasks"]
        ]
    else:
        context.web_ui_task_titles = []


@then("the web UI task list shows:")
def then_web_ui_task_list_shows(context: object) -> None:
    expected: list[str] = []
    if context.table.headings and context.table.headings[0].strip():
        expected.append(context.table.headings[0].strip())
    expected.extend(row.cells[0].strip() for row in context.table)
    expected = [title for title in expected if title]
    assert context.web_ui_task_list_response.status_code == 200
    assert context.web_ui_task_titles == expected


@then("the web UI task list is empty")
def then_web_ui_task_list_is_empty(context: object) -> None:
    assert context.web_ui_task_list_response.status_code == 200
    assert context.web_ui_task_titles == []


@when('the web UI requests task details for the stored task as tenant "{tenant_id}"')
def when_web_ui_requests_stored_task_details(context: object, tenant_id: str) -> None:
    task_id = context.http_task["task_id"]
    response = context.api_client.get(
        f"/tasks/{task_id}",
        headers=tenant_headers(tenant_id),
    )
    context.web_ui_task_detail_response = response
    if response.status_code == 200:
        context.web_ui_task_detail = response.json()


@when('the web UI requests task "{task_id}" as tenant "{tenant_id}"')
def when_web_ui_requests_task(context: object, task_id: str, tenant_id: str) -> None:
    response = context.api_client.get(
        f"/tasks/{task_id}",
        headers=tenant_headers(tenant_id),
    )
    context.web_ui_task_detail_response = response
    context.web_ui_task_detail = (
        response.json() if response.status_code == 200 else None
    )


@then('the web UI task detail shows title "{title}"')
def then_web_ui_task_detail_title(context: object, title: str) -> None:
    assert context.web_ui_task_detail_response.status_code == 200
    assert context.web_ui_task_detail["title"] == title


@then('the web UI task detail shows status "{status}"')
def then_web_ui_task_detail_status(context: object, status: str) -> None:
    assert context.web_ui_task_detail_response.status_code == 200
    assert context.web_ui_task_detail["status"] == status


@then("the web UI task detail request fails with not found")
def then_web_ui_task_detail_not_found(context: object) -> None:
    assert context.web_ui_task_detail_response.status_code == 404
