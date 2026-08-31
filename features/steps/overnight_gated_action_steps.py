"""Behave steps for unattended consequential-action gating."""

from __future__ import annotations

from behave import given, then, when

from chatticus.control_plane import ControlPlane
from chatticus.models import AutoReviewRuleKind
from chatticus.overnight_gated import (
    USER_CONTROLLED_COMPLETION_REQUIRED,
    WAITING_FOR_HUMAN,
)


def _table_args(context: object) -> dict[str, str]:
    table = context.table
    values = {table.headings[0].strip(): table.headings[1].strip()}
    for row in table:
        values[row.cells[0].strip()] = row.cells[1].strip()
    return values


@given("the laptop is closed and no human is at a screen")
def given_laptop_closed(context: object) -> None:
    context.watcher_present = False


@given('a human created an always-allow rule for structured "{action_type}" with:')
def given_human_preauth(context: object, action_type: str) -> None:
    if not hasattr(context, "plane"):
        context.plane = ControlPlane()
    context.plane.add_auto_review_rule(
        AutoReviewRuleKind.ALWAYS_ALLOW,
        action_type,
        "anthus",
        arguments=_table_args(context),
        created_by="human",
    )


@when('the unattended turn reaches structured action "{action_type}" with:')
def when_structured(context: object, action_type: str) -> None:
    context.last_overnight = context.plane.resolve_unattended_gated_action(
        action_type,
        "anthus",
        arguments=_table_args(context),
        channel="structured",
    )


@when('the unattended turn reaches browser action "{action_type}" with:')
def when_browser(context: object, action_type: str) -> None:
    context.last_overnight = context.plane.resolve_unattended_gated_action(
        action_type,
        "anthus",
        arguments=_table_args(context),
        channel="browser",
    )


@when('a bot tries to add an always-allow rule for "{action_type}"')
def when_bot_loosens(context: object, action_type: str) -> None:
    context.plane.add_auto_review_rule(
        AutoReviewRuleKind.ALWAYS_ALLOW,
        action_type,
        "anthus",
        arguments={"recipient": "alex@example.com", "body": "hello"},
        created_by="bot",
    )


@then('a later unattended "{action_type}" with those arguments is still not executed')
def then_later_still_blocked(context: object, action_type: str) -> None:
    later = context.plane.resolve_unattended_gated_action(
        action_type,
        "anthus",
        arguments={"recipient": "alex@example.com", "body": "hello"},
        channel="structured",
    )
    assert later.executed is False


@then("the action is not executed")
def then_not_executed(context: object) -> None:
    assert context.last_overnight.executed is False


@then("the action executes")
def then_executes(context: object) -> None:
    assert context.last_overnight.executed is True
    assert context.last_overnight.turn_status == "completed"


@then("the turn is blocked waiting for a human")
def then_blocked(context: object) -> None:
    assert context.last_overnight.turn_status == "blocked"
    assert context.last_overnight.reason == WAITING_FOR_HUMAN


@then("the kernel refuses the bot-initiated auto-review loosening")
def then_refused_bot(context: object) -> None:
    assert ("anthus", "send") in context.plane.refused_bot_auto_review()


@then("completion evidence is recorded")
def then_evidence(context: object) -> None:
    assert context.last_overnight.completion_evidence


@then("the turn reports that user-controlled completion is required")
def then_user_controlled(context: object) -> None:
    assert context.last_overnight.reason == USER_CONTROLLED_COMPLETION_REQUIRED


@then("the routine does not retry the action unattended")
def then_no_retry(context: object) -> None:
    assert context.last_overnight.retried_unattended is False
