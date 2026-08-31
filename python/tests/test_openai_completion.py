"""Parse Chat Completions payloads into computerless worker outcomes."""

from __future__ import annotations

import pytest

from chatticus.worker.openai_completion import outcome_from_chat_completion


def test_outcome_from_chat_completion_is_text_only_without_tools() -> None:
    outcome = outcome_from_chat_completion(
        {"choices": [{"message": {"content": "Hello there."}}]}
    )
    assert outcome.text == "Hello there."
    assert outcome.wait_gate is None


def test_outcome_from_chat_completion_reads_browser_tool_call() -> None:
    outcome = outcome_from_chat_completion(
        {
            "choices": [
                {
                    "message": {
                        "content": "I will open mail next.",
                        "tool_calls": [
                            {
                                "function": {
                                    "name": "request_computer_capability",
                                    "arguments": '{"gate": "browser"}',
                                }
                            }
                        ],
                    }
                }
            ]
        }
    )
    assert outcome.wait_gate == "browser"
    assert outcome.text == "I will open mail next."


def test_outcome_from_chat_completion_rejects_empty_text_without_a_gate() -> None:
    with pytest.raises(RuntimeError, match="empty completion"):
        outcome_from_chat_completion({"choices": [{"message": {"content": "  "}}]})
