"""Parse Chat Completions payloads into computerless worker outcomes."""

from __future__ import annotations

import logging

import pytest

from chatticus.vendor_prices import TEST_VENDOR_MODEL
from chatticus.worker import openai_completion
from chatticus.worker.openai_completion import (
    WORKER_SYSTEM_PROMPT,
    OpenAITextCompletionClient,
    lowest_reasoning_effort,
    outcome_from_chat_completion,
    usage_from_chat_completion,
)

DEFAULT_OPENAI_MODEL = "gpt-5-nano"


def test_worker_system_prompt_tells_the_model_when_to_call_the_gate() -> None:
    assert "request_computer_capability" in WORKER_SYSTEM_PROMPT
    assert "browser" in WORKER_SYSTEM_PROMPT


def test_outcome_from_chat_completion_is_text_only_without_tools() -> None:
    outcome = outcome_from_chat_completion(
        {"choices": [{"message": {"content": "Hello there."}}]},
        model=TEST_VENDOR_MODEL,
    )
    assert outcome.text == "Hello there."
    assert outcome.wait_gate is None
    assert outcome.usage.input_tokens == 0
    assert outcome.usage.output_tokens == 0


def test_outcome_from_chat_completion_reads_browser_tool_call() -> None:
    outcome = outcome_from_chat_completion(
        {
            "usage": {"prompt_tokens": 1, "completion_tokens": 2},
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
            ],
        },
        model=TEST_VENDOR_MODEL,
    )
    assert outcome.wait_gate == "browser"
    assert outcome.text == "I will open mail next."
    assert outcome.usage.input_tokens == 1
    assert outcome.usage.output_tokens == 2


def test_outcome_from_chat_completion_rejects_empty_text_without_a_gate() -> None:
    with pytest.raises(RuntimeError, match="empty completion"):
        outcome_from_chat_completion(
            {"choices": [{"message": {"content": "  "}}]},
            model=TEST_VENDOR_MODEL,
        )


def test_usage_from_chat_completion_logs_warning_when_missing(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.WARNING):
        usage = usage_from_chat_completion({}, DEFAULT_OPENAI_MODEL)
    assert usage.input_tokens == 0
    assert usage.output_tokens == 0


def test_completion_request_uses_settings_gpt_5_nano_accepts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}

    class _Response:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {"choices": [{"message": {"content": "Hi."}}]}

    def _post(url: str, **kwargs: object) -> _Response:
        captured.update(kwargs["json"])
        return _Response()

    monkeypatch.setattr(openai_completion.httpx, "post", _post)
    OpenAITextCompletionClient("test-key").complete("Say hi.")
    assert captured["model"] == DEFAULT_OPENAI_MODEL
    assert captured["reasoning_effort"] == "minimal"
    assert captured["tool_choice"] == "auto"
    assert captured["tools"]


def test_lowest_reasoning_effort_matches_what_each_model_accepts() -> None:
    assert lowest_reasoning_effort("gpt-5-nano") == "minimal"
    assert lowest_reasoning_effort("gpt-5-mini") == "minimal"
    assert lowest_reasoning_effort("gpt-5") == "minimal"
    assert lowest_reasoning_effort("gpt-5-nano-2025-08-07") == "minimal"
    assert lowest_reasoning_effort("gpt-5.6-luna") == "none"
    assert lowest_reasoning_effort("gpt-6-luna") == "none"
    assert lowest_reasoning_effort("gpt-5.1") == "none"
