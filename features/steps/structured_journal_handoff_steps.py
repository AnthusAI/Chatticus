"""Behave steps for structured journal computer handoff."""

from __future__ import annotations

from behave import then, when

from chatticus.escalation_handoff import EscalationBoundary, EscalationCrash
from chatticus.models import TurnEventKind
from chatticus.structured_handoff_driver import (
    StructuredHandoffDriver,
    journal_has_typed_handoff,
)


def _structured(context: object) -> StructuredHandoffDriver:
    driver = getattr(context, "structured_handoff", None)
    if driver is not None:
        return driver
    driver = StructuredHandoffDriver(context.plane)
    prior = getattr(context, "escalation_driver", None)
    if prior is not None and prior.turn_id is not None:
        driver.turn_id = prior.turn_id
        driver.computer_id = prior.computer_id
        driver.tenant_id = prior.tenant_id
        driver.user_id = prior.user_id
    else:
        driver.given_ready_to_request_computer_tool()
    context.structured_handoff = driver
    context.escalation_driver = driver
    return driver


@when(
    "the computerless attempt records a model request and finishes the fenced handoff"
)
def when_finish_fenced_handoff(context: object) -> None:
    driver = _structured(context)
    context.structured_outcome = driver.finish_happy_path()
    context.escalation_outcome = context.structured_outcome


@when("the structured handoff worker stops {boundary}")
def when_structured_stops(context: object, boundary: str) -> None:
    driver = _structured(context)
    try:
        driver.crash_at(EscalationBoundary(boundary.strip()))
    except EscalationCrash:
        pass
    context.structured_outcome = driver.recover()
    context.escalation_outcome = context.structured_outcome


@then(
    "the turn journal has typed model.request, tool.call, "
    "tool.result, and attempt events"
)
def then_typed_journal(context: object) -> None:
    assert journal_has_typed_handoff(context.structured_outcome.journal_kinds)


@then("those events are not stored only as token chunks")
def then_not_only_tokens(context: object) -> None:
    kinds = set(context.structured_outcome.journal_kinds)
    typed = {
        TurnEventKind.MODEL_REQUEST,
        TurnEventKind.TOOL_CALL,
        TurnEventKind.TOOL_RESULT,
        TurnEventKind.ATTEMPT_CLAIMED,
        TurnEventKind.ATTEMPT_RELINQUISHED,
    }
    assert typed.issubset(kinds)
    assert TurnEventKind.TURN_TOKEN not in typed


@then("the executed tool action id matches the committed call")
def then_action_id_matches(context: object) -> None:
    driver = context.structured_handoff
    record = driver.plane.escalation_for(driver.tenant_id, driver.turn_id)
    assert record.executed_action_id == record.pending_call.action_id
    assert record.executed_action_id


@then("no unresolved tool calls remain")
def then_no_unresolved(context: object) -> None:
    assert context.structured_outcome.unresolved_action_ids == []


@then("only unresolved tool calls are executed")
def then_only_unresolved_executed(context: object) -> None:
    outcome = context.structured_outcome
    assert outcome.computer_action_count <= 1
    assert outcome.unresolved_action_ids == []


@then("the computer was reclaimed by a later attempt")
def then_computer_reclaimed(context: object) -> None:
    assert context.structured_outcome.computer_reclaimed is True


@then("the same action id is not executed twice")
def then_action_not_twice(context: object) -> None:
    assert context.structured_outcome.computer_action_count == 1
