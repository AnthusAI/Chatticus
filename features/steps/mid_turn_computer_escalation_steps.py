"""Behave steps for happy-path mid-turn computer escalation."""

from __future__ import annotations

from behave import given, then

from chatticus.escalation_driver import MidTurnEscalationDriver


@given(
    "a computerless attempt has committed model output "
    "and one pending computer tool call"
)
def given_pending_computer_call(context: object) -> None:
    context.mid_turn = MidTurnEscalationDriver(context.plane)
    context.mid_turn.given_computerless_output_and_pending_call()


@then("one computer-capable attempt executes that exact pending call")
def then_exact_pending_call(context: object) -> None:
    outcome = context.mid_turn_outcome
    assert outcome.executed_action_id == outcome.pending_action_id
    assert outcome.computer_action_count == 1


@then("the tool result is appended to the same turn")
def then_result_same_turn(context: object) -> None:
    outcome = context.mid_turn_outcome
    assert outcome.same_turn is True
    assert outcome.result_body == "inbox-open"
    marker = f"[tool:{outcome.pending_action_id}]inbox-open"
    assert marker in outcome.progress_tokens


@then("the model continues after the result")
def then_model_continues(context: object) -> None:
    outcome = context.mid_turn_outcome
    assert outcome.computerless_output == "I will open household mail."
    assert outcome.continuation_output == " Inbox has three unread."
    assert outcome.progress_tokens[-1] == " Inbox has three unread."


@then("no completed tool result is replayed")
def then_no_replay(context: object) -> None:
    outcome = context.mid_turn_outcome
    assert outcome.result_body == "inbox-open"
    assert outcome.result_replay_attempts == 1
    assert outcome.computer_action_count == 1
