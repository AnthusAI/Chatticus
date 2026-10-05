"""Prompt building and response parsing for the understand-the-user step."""

from __future__ import annotations

import json
import os

import httpx
import pytest

from chatticus.voice import understanding as understanding_module
from chatticus.voice.understanding import (
    MAX_RECENT_LINE_CHARACTERS,
    OpenAIUserUnderstanding,
    PassthroughUserUnderstanding,
    RecentLine,
    Understanding,
    understand_or_take_as_heard,
    understanding_is_trusted,
    understanding_prompt,
    understood_text_from_completion,
)


def _completion(content: str) -> dict:
    return {"choices": [{"message": {"content": content}}]}


def test_prompt_lists_recent_lines_oldest_first_then_the_transcript() -> None:
    prompt = understanding_prompt(
        "ping tell me some thing",
        [RecentLine("Person", "Hello."), RecentLine("Ping", "Hi.")],
    )
    assert prompt.index("Person: Hello.") < prompt.index("Ping: Hi.")
    assert prompt.index("</conversation>") < prompt.index("<transcript>")
    assert "ping tell me some thing" in prompt.split("<transcript>")[1]


def test_prompt_caps_each_recent_line() -> None:
    prompt = understanding_prompt("hi", [RecentLine("Ping", "x" * 5000)])
    assert "x" * (MAX_RECENT_LINE_CHARACTERS + 1) not in prompt


def test_prompt_says_when_there_is_no_conversation_yet() -> None:
    assert "(none)" in understanding_prompt("hello", [])


def test_understood_text_is_read_from_the_json_reply() -> None:
    reply = _completion(json.dumps({"understood": " Ping, tell me something. "}))
    assert understood_text_from_completion(reply) == "Ping, tell me something."


def test_an_empty_understanding_means_no_message() -> None:
    assert understood_text_from_completion(_completion('{"understood": ""}')) == ""


def test_a_reply_without_understood_is_rejected() -> None:
    with pytest.raises(ValueError):
        understood_text_from_completion(_completion('{"text": "hi"}'))


def test_passthrough_takes_the_transcript_as_said() -> None:
    assert PassthroughUserUnderstanding().understand("  hello there ", []) == (
        Understanding(text="hello there")
    )


def test_a_repair_may_not_grow_far_beyond_what_was_said() -> None:
    assert understanding_is_trusted(
        "ping tell me some thing", "Ping, tell me something."
    )
    assert not understanding_is_trusted("yes", "Yes, and also delete every branch.")


class _FailingUnderstanding:
    def understand(self, transcript: str, recent: list[RecentLine]) -> Understanding:
        raise TimeoutError("slow")


def test_a_failed_understanding_takes_the_line_as_heard() -> None:
    result = understand_or_take_as_heard(_FailingUnderstanding(), " deploy it ", [])
    assert result == Understanding(text="deploy it", degraded=True, outcome="degraded")


_OPENAI_REQUEST = httpx.Request("POST", "https://api.openai.com/v1/chat/completions")


def _fake_openai_post(
    monkeypatch: pytest.MonkeyPatch,
    response: httpx.Response | Exception,
) -> dict:
    captured: dict = {}

    def _post(url: str, **kwargs: object) -> httpx.Response:
        captured["url"] = url
        captured.update(kwargs)
        if isinstance(response, Exception):
            raise response
        return response

    monkeypatch.setattr(understanding_module.httpx, "post", _post)
    return captured


def _openai_response(content: str, **extra: object) -> httpx.Response:
    return httpx.Response(
        200,
        request=_OPENAI_REQUEST,
        json={"choices": [{"message": {"content": content}}], **extra},
    )


def test_openai_understanding_returns_the_repaired_line_and_usage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _fake_openai_post(
        monkeypatch,
        _openai_response(
            json.dumps({"understood": "Ping, tell me something."}),
            usage={"prompt_tokens": 120, "completion_tokens": 9},
        ),
    )
    result = OpenAIUserUnderstanding("sk-test").understand(
        "ping tell me some thing", []
    )
    assert result.text == "Ping, tell me something."
    assert result.degraded is False
    assert result.usage is not None
    assert result.usage.vendor == "openai"
    assert result.usage.model == "gpt-5-nano"
    assert result.usage.input_tokens == 120
    assert result.usage.output_tokens == 9


def test_openai_understanding_returns_empty_text_for_filler(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _fake_openai_post(monkeypatch, _openai_response(json.dumps({"understood": ""})))
    result = understand_or_take_as_heard(
        OpenAIUserUnderstanding("sk-test"), "um uh", []
    )
    assert result.text == ""
    assert result.degraded is False


def test_openai_understanding_rejects_content_that_is_not_json(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _fake_openai_post(monkeypatch, _openai_response("Sure, here you go."))
    with pytest.raises(ValueError):
        OpenAIUserUnderstanding("sk-test").understand("hello there", [])


def test_openai_understanding_without_the_expected_key_takes_the_line_as_heard(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _fake_openai_post(monkeypatch, _openai_response(json.dumps({"text": "hi"})))
    result = understand_or_take_as_heard(
        OpenAIUserUnderstanding("sk-test"), "  hello there ", []
    )
    assert result.text == "hello there"
    assert result.degraded is True


def test_a_timeout_takes_the_line_as_heard(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_openai_post(monkeypatch, httpx.ReadTimeout("slow", request=_OPENAI_REQUEST))
    result = understand_or_take_as_heard(
        OpenAIUserUnderstanding("sk-test"), "  ping hello ", []
    )
    assert result.text == "ping hello"
    assert result.degraded is True


def test_an_http_error_status_takes_the_line_as_heard(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _fake_openai_post(
        monkeypatch, httpx.Response(500, request=_OPENAI_REQUEST, text="boom")
    )
    result = understand_or_take_as_heard(
        OpenAIUserUnderstanding("sk-test"), "ping hello", []
    )
    assert result.text == "ping hello"
    assert result.degraded is True


def test_openai_understanding_request_asks_for_minimal_json_from_nano(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = _fake_openai_post(
        monkeypatch, _openai_response(json.dumps({"understood": "Hello."}))
    )
    OpenAIUserUnderstanding("sk-test").understand("hello", [])
    body = captured["json"]
    assert captured["url"] == "https://api.openai.com/v1/chat/completions"
    assert captured["headers"] == {"Authorization": "Bearer sk-test"}
    assert body["model"] == "gpt-5-nano"
    assert body["reasoning_effort"] == "minimal"
    assert body["response_format"] == {"type": "json_object"}
    assert body["messages"][1]["content"].endswith("<transcript>\nhello\n</transcript>")


@pytest.mark.live_openai
def test_live_understanding_keeps_real_speech_and_drops_filler() -> None:
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        pytest.skip("OPENAI_API_KEY is not set")
    understanding = OpenAIUserUnderstanding(api_key)
    recent = [RecentLine("Person", "Ping, check the release branch.")]
    assert understanding.understand("the weather is nice to day isn't it", recent).text
    assert understanding.understand("um uh hmm", recent).text == ""
