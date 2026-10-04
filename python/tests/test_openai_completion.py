"""Parse Chat Completions payloads into computerless worker outcomes."""

from __future__ import annotations

import logging

import httpx
import pytest

from chatticus.vendor_prices import TEST_VENDOR_MODEL
from chatticus.worker import openai_completion
from chatticus.worker.model_provider_errors import (
    OUT_OF_QUOTA_REASON,
    REJECTED_KEY_REASON,
    permanent_model_provider_failure,
)
from chatticus.worker.openai_completion import (
    WORKER_SYSTEM_PROMPT,
    OpenAITextCompletionClient,
    lowest_reasoning_effort,
    outcome_from_chat_completion,
    usage_from_chat_completion,
)

DEFAULT_OPENAI_MODEL = "gpt-5-nano"
_OPENAI_REQUEST = httpx.Request("POST", "https://api.openai.com/v1/chat/completions")


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


def _fake_openai_post(
    monkeypatch: pytest.MonkeyPatch,
    response: httpx.Response,
) -> None:
    def _post(url: str, **kwargs: object) -> httpx.Response:
        return response

    monkeypatch.setattr(openai_completion.httpx, "post", _post)


def _openai_response(status: int, **kwargs: object) -> httpx.Response:
    return httpx.Response(status, request=_OPENAI_REQUEST, **kwargs)


def _complete_expecting_provider_error(
    monkeypatch: pytest.MonkeyPatch, response: httpx.Response
) -> Exception:
    _fake_openai_post(monkeypatch, response)
    with pytest.raises(httpx.HTTPStatusError) as raised:
        OpenAITextCompletionClient("sk-test").complete("Say hi.")
    return raised.value


def test_a_successful_completion_carries_text_and_usage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _fake_openai_post(
        monkeypatch,
        _openai_response(
            200,
            json={
                "usage": {"prompt_tokens": 30, "completion_tokens": 4},
                "choices": [{"message": {"content": "Hi there."}}],
            },
        ),
    )
    outcome = OpenAITextCompletionClient("sk-test").complete("Say hi.")
    assert outcome.text == "Hi there."
    assert outcome.usage.model == "gpt-5-nano"
    assert outcome.usage.input_tokens == 30
    assert outcome.usage.output_tokens == 4


def test_insufficient_quota_from_the_completion_call_is_permanent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    error = _complete_expecting_provider_error(
        monkeypatch,
        _openai_response(429, json={"error": {"code": "insufficient_quota"}}),
    )
    failure = permanent_model_provider_failure(error)
    assert failure is not None
    assert failure.reason == OUT_OF_QUOTA_REASON


def test_a_rejected_key_from_the_completion_call_is_permanent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    error = _complete_expecting_provider_error(
        monkeypatch,
        _openai_response(401, json={"error": {"code": "invalid_api_key"}}),
    )
    failure = permanent_model_provider_failure(error)
    assert failure is not None
    assert failure.reason == REJECTED_KEY_REASON


def test_server_errors_and_rate_limits_from_the_completion_call_are_temporary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server_error = _complete_expecting_provider_error(
        monkeypatch, _openai_response(500, json={"error": {"code": "server_error"}})
    )
    rate_limited = _complete_expecting_provider_error(
        monkeypatch,
        _openai_response(429, json={"error": {"code": "rate_limit_exceeded"}}),
    )
    assert permanent_model_provider_failure(server_error) is None
    assert permanent_model_provider_failure(rate_limited) is None


def test_a_non_json_error_body_from_the_completion_call_is_temporary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    error = _complete_expecting_provider_error(
        monkeypatch, _openai_response(401, text="<html>bad gateway</html>")
    )
    assert permanent_model_provider_failure(error) is None
