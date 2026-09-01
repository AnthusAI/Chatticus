"""Behave steps for the thin Task item kernel."""

from __future__ import annotations

from behave import given, then, when

from chatticus.models import TaskEvidenceRequiredError, TaskStatus
from chatticus.thin_task import ThinTaskDriver


@given("the household computer is stopped for task work")
def given_household_computer_stopped_for_tasks(context: object) -> None:
    context.task_driver = ThinTaskDriver(context.plane)
    context.task_driver.given_stopped_computer()


@when('bot "{bot_name}" uses the task tool to create a task titled "{title}"')
def when_bot_creates_task(context: object, bot_name: str, title: str) -> None:
    if not hasattr(context, "task_driver"):
        context.task_driver = ThinTaskDriver(context.plane)
    context.last_task = context.task_driver.create_task_via_tool(
        title, bot_name=bot_name
    )


@given('bot "{bot_name}" has an open task "{title}"')
def given_open_task(context: object, bot_name: str, title: str) -> None:
    if not hasattr(context, "task_driver"):
        context.task_driver = ThinTaskDriver(context.plane)
    context.last_task = context.task_driver.given_open_task(title, bot_name=bot_name)


@when('bot "{bot_name}" tries to complete the task without evidence')
def when_complete_without_evidence(context: object, bot_name: str) -> None:
    context.task_driver.try_complete_without_evidence(bot_name=bot_name)


@when('bot "{bot_name}" completes the task with evidence "{evidence}"')
def when_complete_with_evidence(context: object, bot_name: str, evidence: str) -> None:
    context.last_task = context.task_driver.complete_task(evidence, bot_name=bot_name)


@when('bot "{bot_name}" closes the task with reason "{reason}"')
def when_close_task(context: object, bot_name: str, reason: str) -> None:
    context.last_task = context.task_driver.close_task(reason, bot_name=bot_name)


@when('tenant "{tenant_id}" tries to read that task')
def when_other_tenant_reads(context: object, tenant_id: str) -> None:
    context.task_driver.tenant_id = tenant_id
    context.task_driver.try_read_from_other_tenant()


@then('the task is stored with status "{status}"')
def then_task_status(context: object, status: str) -> None:
    assert context.last_task is not None
    assert context.last_task.status == TaskStatus(status)


@then('the task records bot "{bot_name}" as provenance')
def then_task_provenance(context: object, bot_name: str) -> None:
    bot = context.plane.bot_by_name(context.task_driver.tenant_id, "ryan", bot_name)
    assert context.last_task is not None
    assert context.last_task.created_by_bot_id == bot.bot_id


@then("no computer was summoned for the task tool")
def then_no_computer_summoned(context: object) -> None:
    assert context.task_driver.computer_summoned is False
    assert context.plane.pending_jobs() == []


@then("completing the task is refused for missing evidence")
def then_completion_refused(context: object) -> None:
    assert isinstance(context.task_driver.last_error, TaskEvidenceRequiredError)


@then('the task evidence is "{evidence}"')
def then_task_evidence(context: object, evidence: str) -> None:
    assert context.last_task is not None
    assert context.last_task.evidence == evidence


@then('the task close reason is "{reason}"')
def then_task_close_reason(context: object, reason: str) -> None:
    assert context.last_task is not None
    assert context.last_task.close_reason == reason


@then("the task is not visible to the other tenant")
def then_task_not_visible(context: object) -> None:
    assert context.task_driver.last_error is not None
