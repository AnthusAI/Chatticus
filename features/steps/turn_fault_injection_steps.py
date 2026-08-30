"""Step definitions for turn boundary fault injection."""

from __future__ import annotations

from behave import given, then, when

from chatticus.models import TurnStatus
from chatticus.turn_fault_hooks import CrashWindow, TurnBoundary
from chatticus.turn_fault_injection import TurnFaultDriver


def _parse_boundary(name: str) -> TurnBoundary:
    return TurnBoundary(name.replace(" ", "_"))


def _parse_window(name: str) -> CrashWindow:
    return CrashWindow(name)


@given('a turn fault harness for tenant "{tenant_id}" user "{user_id}"')
def given_turn_fault_harness(context: object, tenant_id: str, user_id: str) -> None:
    context.fault_driver = TurnFaultDriver(tenant_id=tenant_id, user_id=user_id)
    context.fault_boundary = None
    context.fault_window = None
    context.fault_outcome = None


@given("the harness arms a crash {window} {boundary}")
def given_harness_arms_crash(context: object, window: str, boundary: str) -> None:
    context.fault_window = _parse_window(window)
    context.fault_boundary = _parse_boundary(boundary)


@when("the harness drives the turn until the crash")
def when_harness_drives_until_crash(context: object) -> None:
    assert context.fault_boundary is not None
    assert context.fault_window is not None
    context.fault_driver.drive_until_crash(context.fault_boundary, context.fault_window)


@when("the harness recovers and completes the turn")
def when_harness_recovers(context: object) -> None:
    assert context.fault_boundary is not None
    assert context.fault_window is not None
    context.fault_outcome = context.fault_driver.recover_and_complete(
        context.fault_boundary, context.fault_window
    )


@then("provider calls equal {count:d}")
def then_provider_calls(context: object, count: int) -> None:
    assert context.fault_outcome is not None
    assert context.fault_outcome.provider_calls == count


@then("the channel has one human message and one bot answer")
def then_channel_messages(context: object) -> None:
    assert context.fault_outcome is not None
    assert context.fault_outcome.human_messages == 1
    assert context.fault_outcome.bot_messages == 1


@then("the turn status is completed")
def then_turn_completed(context: object) -> None:
    assert context.fault_outcome is not None
    assert context.fault_outcome.turn_status == TurnStatus.COMPLETED


@then("at most one worker is authoritative")
def then_single_authoritative_worker(context: object) -> None:
    assert context.fault_outcome is not None
    assert len(context.fault_outcome.authoritative_workers) <= 1
