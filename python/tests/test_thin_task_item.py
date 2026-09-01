"""Kernel tests for the thin Task item."""

from __future__ import annotations

from chatticus.messaging.store import DynamoMessagingStore, create_messaging_table
from chatticus.models import TaskEvidenceRequiredError, TaskStatus
from chatticus.thin_task import (
    TASK_TOOL_NAME,
    ThinTaskDriver,
    invoke_task_tool,
    task_tool_schema,
)


def test_task_tool_schema_exposes_v1_fields() -> None:
    schema = task_tool_schema()
    assert schema["name"] == TASK_TOOL_NAME
    assert schema["readiness_gate"] == "first"
    assert "status" in schema["fields"]
    assert "evidence" in schema["fields"]


def test_create_task_without_computer() -> None:
    driver = ThinTaskDriver()
    driver.given_stopped_computer()
    task = driver.create_task_via_tool("Pay the electric bill")
    assert task.status == TaskStatus.OPEN
    assert task.created_by_bot_id is not None
    assert driver.computer_summoned is False


def test_complete_requires_evidence() -> None:
    driver = ThinTaskDriver()
    driver.given_open_task("submit taxes")
    driver.try_complete_without_evidence()
    assert isinstance(driver.last_error, TaskEvidenceRequiredError)


def test_complete_with_evidence() -> None:
    driver = ThinTaskDriver()
    driver.given_open_task("file the return")
    task = driver.complete_task("confirmation-id:ret-42")
    assert task.status == TaskStatus.COMPLETED
    assert task.evidence == "confirmation-id:ret-42"


def test_close_with_reason() -> None:
    driver = ThinTaskDriver()
    driver.given_open_task("renew insurance")
    task = driver.close_task("household chose another provider")
    assert task.status == TaskStatus.CLOSED
    assert task.close_reason == "household chose another provider"


def test_tasks_are_tenant_isolated() -> None:
    driver = ThinTaskDriver()
    driver.given_open_task("household chore")
    driver.try_read_from_other_tenant()
    assert driver.last_error is not None


def test_task_persists_in_dynamo_store() -> None:
    import boto3
    from moto import mock_aws

    with mock_aws():
        client = boto3.client("dynamodb", region_name="us-east-1")
        table_name = "chatticus-messaging"
        create_messaging_table(client, table_name)
        store = DynamoMessagingStore(table_name, client=client)
        from chatticus.control_plane import ControlPlane

        plane = ControlPlane(messaging_store=store)
        bot = plane.create_bot("anthus", "ryan", "Assistant")
        task = invoke_task_tool(
            plane,
            tenant_id="anthus",
            user_id="ryan",
            bot_id=bot.bot_id,
            action="create",
            arguments={"title": "durable task"},
        ).task
        assert task is not None
        recycled = ControlPlane(messaging_store=store)
        loaded = recycled.task("anthus", task.task_id)
        assert loaded.title == "durable task"
        assert loaded.status == TaskStatus.OPEN
