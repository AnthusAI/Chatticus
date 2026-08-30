"""Behave steps for capability-gated readiness."""

from __future__ import annotations

from behave import given, then, when

from chatticus.capability_gated_readiness import (
    BROWSER_CAPABILITY,
    CapabilityGatedTurnDriver,
)


@given("the household computer is stopped")
def given_computer_stopped(context: object) -> None:
    context.capability_driver = CapabilityGatedTurnDriver(context.plane)
    context.capability_driver.given_stopped_computer()


@given("a turn has useful work that needs no computer before a browser step")
def given_preparatory_work(context: object) -> None:
    context.capability_driver.given_preparatory_then_browser_work()


@when("the addressed bot begins the turn")
def when_bot_begins_turn(context: object) -> None:
    context.capability_state = context.capability_driver.begin_turn()


@when("the household computer becomes ready")
def when_computer_ready(context: object) -> None:
    context.capability_driver.mark_computer_ready()


@when("the turn continues after the browser capability is ready")
def when_turn_continues(context: object) -> None:
    context.capability_state = context.capability_driver.continue_turn()


@then("it performs the computerless work immediately")
def then_computerless_work(context: object) -> None:
    assert context.capability_state.preparatory_output is not None
    assert context.capability_driver.preparatory_emitted_before_waiting()


@then("it emits a waiting state naming the computer capability only when blocked")
def then_waiting_emitted(context: object) -> None:
    assert context.capability_state.waiting_emitted is True
    assert context.capability_state.waiting_for == BROWSER_CAPABILITY
    assert context.capability_driver.turn_waiting_gates() == [BROWSER_CAPABILITY]


@then("it makes no claim that the browser work is complete")
def then_no_browser_complete(context: object) -> None:
    assert context.capability_state.browser_claimed_complete is False
    assert context.capability_driver.turn_completed() is False


@then("it continues the same turn after the computer becomes ready")
def then_continues_same_turn(context: object) -> None:
    assert context.capability_state.continued_same_turn is True
    assert (
        context.capability_state.completed_turn_id == context.capability_state.turn_id
    )
    assert context.capability_driver.turn_completed() is True
