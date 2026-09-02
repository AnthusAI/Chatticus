"""Behave steps for HTTP turn capability grants."""

from __future__ import annotations

from behave import then, when
from worker_http_helpers import worker_auth_headers

from chatticus.capability_policy import grant_to_payload, parse_grant_table
from chatticus.http.paths import org_path


def _table_map(context: object) -> dict[str, str]:
    table = context.table
    values = {table.headings[0].strip(): table.headings[1].strip()}
    for row in table:
        values[row.cells[0].strip()] = row.cells[1].strip()
    return values


def _grant_payload_from_table(context: object) -> dict[str, list[str]]:
    grant = parse_grant_table(_table_map(context))
    return grant_to_payload(grant)


def _active_turn_id(context: object) -> str:
    if context.last_turn_id is None:
        raise AssertionError("No turn is active in this scenario.")
    return context.last_turn_id


def _registered_worker_id(context: object) -> str:
    worker_id = getattr(context, "last_worker_id", None)
    if worker_id is None:
        raise AssertionError("No worker is registered in this scenario.")
    return worker_id


def _tenant_id(context: object) -> str:
    tenant_id = getattr(context, "last_worker_tenant_id", None)
    if tenant_id is None:
        return "anthus"
    return tenant_id


@when('the registered worker puts a turn grant over HTTP for turn "{turn_id}":')
def when_put_grant_for_turn(context: object, turn_id: str) -> None:
    tenant_id = _tenant_id(context)
    payload = _grant_payload_from_table(context)
    response = context.api_client.put(
        org_path(tenant_id, f"/turns/{turn_id}/grant"),
        json=payload,
        headers=worker_auth_headers(context, _registered_worker_id(context)),
    )
    context.grant_http_response = response


@when("the registered worker puts a turn grant for the active turn over HTTP:")
def when_put_grant_for_active_turn(context: object) -> None:
    when_put_grant_for_turn(context, _active_turn_id(context))


@when(
    "the registered worker posts turn workspace read over HTTP "
    'for user "{user_id}" path "{path}"'
)
def when_post_workspace_read(context: object, user_id: str, path: str) -> None:
    tenant_id = _tenant_id(context)
    turn_id = _active_turn_id(context)
    response = context.api_client.post(
        org_path(tenant_id, f"/turns/{turn_id}/workspace/read"),
        json={"user_id": user_id, "path": path},
        headers=worker_auth_headers(context, _registered_worker_id(context)),
    )
    context.workspace_read_http_response = response


@then("the turn grant HTTP response has status {status:d}")
def then_grant_http_status(context: object, status: int) -> None:
    assert (
        context.grant_http_response.status_code == status
    ), context.grant_http_response.text


@then("the workspace read HTTP response has status {status:d}")
def then_workspace_read_http_status(context: object, status: int) -> None:
    assert (
        context.workspace_read_http_response.status_code == status
    ), context.workspace_read_http_response.text


@then('the workspace read HTTP content equals "{content}"')
def then_workspace_read_http_content(context: object, content: str) -> None:
    payload = context.workspace_read_http_response.json()
    assert payload["content"] == content
