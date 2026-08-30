"""Kernel tests for same-turn computer-tool continuation."""

from __future__ import annotations

from chatticus.escalation_driver import MidTurnEscalationDriver


def test_first_computer_tool_continues_the_same_turn() -> None:
    driver = MidTurnEscalationDriver()
    driver.given_computerless_output_and_pending_call()
    outcome = driver.when_computer_becomes_ready()
    assert outcome.same_turn is True
    assert outcome.executed_action_id == outcome.pending_action_id
    assert outcome.computer_action_count == 1
    assert outcome.result_body == "inbox-open"
    assert outcome.computerless_output == "I will open household mail."
    assert outcome.continuation_output == " Inbox has three unread."
    assert outcome.result_replay_attempts == 1
    marker = f"[tool:{outcome.pending_action_id}]inbox-open"
    assert marker in outcome.progress_tokens
    assert outcome.progress_tokens[0] == "I will open household mail."
    assert outcome.progress_tokens[-1] == " Inbox has three unread."
