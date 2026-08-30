"""Behave steps for single computer start."""

from __future__ import annotations

from behave import then, when

from chatticus.computer_start_driver import SingleComputerStartDriver


@when("two eligible turns request that computer concurrently")
def when_two_turns_request(context: object) -> None:
    context.single_start = SingleComputerStartDriver(context.plane)
    context.single_start_outcome = context.single_start.request_two_turns_concurrently()


@then("the platform issues one host start request")
def then_one_host_start(context: object) -> None:
    assert context.single_start_outcome.host_start_count == 1


@then("both turns wait for the same computer identity")
def then_same_computer(context: object) -> None:
    outcome = context.single_start_outcome
    assert len(set(outcome.computer_ids)) == 1
    assert len(outcome.waiting_turn_ids) == 2


@then("at most one live host may write that computer")
def then_one_writer(context: object) -> None:
    outcome = context.single_start_outcome
    assert outcome.write_host_a is True
    assert outcome.write_host_b is False
    assert outcome.live_writer_host_id == "host-a"
