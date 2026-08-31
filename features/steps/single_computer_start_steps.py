"""Behave steps for single computer start."""

from __future__ import annotations

from behave import given, then, when

from chatticus.computer_start_driver import SingleComputerStartDriver


def _driver(context: object) -> SingleComputerStartDriver:
    driver = getattr(context, "single_start", None)
    if driver is None:
        driver = SingleComputerStartDriver(context.plane)
        driver.computer_id = None
        context.single_start = driver
    return driver


@given('the household computer "{computer_id}" is stopped')
def given_named_computer_stopped(context: object, computer_id: str) -> None:
    driver = SingleComputerStartDriver(context.plane)
    driver.computer_id = computer_id
    driver.given_stopped_computer()
    context.single_start = driver


@given("a turn has requested a host start for that computer")
def given_turn_requested_host_start(context: object) -> None:
    _driver(context).request_host_start()


@when("two eligible turns request that computer concurrently")
def when_two_turns_request(context: object) -> None:
    context.single_start = SingleComputerStartDriver(context.plane)
    context.single_start_outcome = context.single_start.request_two_turns_concurrently()


@when("a turn requests a host start for that computer")
def when_turn_requests_host_start(context: object) -> None:
    _driver(context).request_host_start()


@when("the same turn retries the host start request")
def when_same_turn_retries(context: object) -> None:
    _driver(context).retry_host_start()


@when("the host start lease expires without a live writer")
def when_host_start_lease_expires(context: object) -> None:
    _driver(context).expire_host_start_lease()


@when("another turn requests a host start for that computer")
def when_another_turn_requests_host_start(context: object) -> None:
    driver = _driver(context)
    driver._last_turn_id = None
    driver.request_host_start()


@given("the local host last reconciled snapshot generation {generation:d}")
def given_local_reconciled_generation(context: object, generation: int) -> None:
    _driver(context).set_local_reconciled_generation(generation)


@given("a newer snapshot generation {generation:d} is published on the remote host")
def given_remote_publishes_generation(context: object, generation: int) -> None:
    _driver(context).publish_remote_snapshot_generation(generation)


@when("the platform selects a host to start the computer")
def when_select_start_host(context: object) -> None:
    context.selected_start_host = _driver(context).select_start_host()


@when("the local host reconciles to snapshot generation {generation:d}")
def when_local_reconciles(context: object, generation: int) -> None:
    _driver(context).reconcile_local_host(generation)


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


@then("the platform still has one logical host start")
def then_still_one_host_start(context: object) -> None:
    assert _driver(context).host_start_count() == 1


@then("the platform has issued two logical host starts")
def then_two_host_starts(context: object) -> None:
    assert _driver(context).host_start_count() == 2


@then("the wedged disk write lock is cleared")
def then_disk_write_lock_cleared(context: object) -> None:
    assert _driver(context).disk_write_lock_held() is False


@then('the selected host is "{worker_id}"')
def then_selected_host(context: object, worker_id: str) -> None:
    assert context.selected_start_host == worker_id
