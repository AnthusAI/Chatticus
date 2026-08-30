"""Behave steps for computer-handoff crash recovery."""

from __future__ import annotations

from behave import given, then, when

from chatticus.escalation_driver import EscalationHandoffDriver
from chatticus.escalation_handoff import EscalationBoundary, EscalationCrash


@given("a computerless turn is ready to request a computer tool")
def given_ready_to_escalate(context: object) -> None:
    context.escalation_driver = EscalationHandoffDriver(context.plane)
    context.escalation_driver.given_ready_to_request_computer_tool()


@when("its worker stops {boundary}")
def when_worker_stops(context: object, boundary: str) -> None:
    try:
        context.escalation_driver.crash_at(EscalationBoundary(boundary.strip()))
    except EscalationCrash:
        pass
    context.escalation_outcome = context.escalation_driver.recover()


@then("the pending call is either continued exactly once or the turn ends visibly")
def then_continued_or_visible(context: object) -> None:
    outcome = context.escalation_outcome
    assert outcome.computer_action_count <= 1
    assert outcome.pending_continued_once or outcome.ended_visibly


@then("only one attempt can control the computer")
def then_single_computer_controller(context: object) -> None:
    assert len(context.escalation_outcome.computer_controllers) <= 1


@then("an orphaned computer claim expires")
def then_orphan_expires(context: object) -> None:
    assert context.escalation_outcome.orphan_claim_expired is True
