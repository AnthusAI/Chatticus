"""Prompt building and response parsing for the understand-the-user step."""

from __future__ import annotations

import json
import os

import pytest

from chatticus.voice.understanding import (
    OpenAIUserUnderstanding,
    PassthroughUserUnderstanding,
    RecentLine,
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
    assert prompt.rstrip().endswith("ping tell me some thing")


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
        "hello there"
    )


@pytest.mark.live_openai
def test_live_understanding_keeps_real_speech_and_drops_filler() -> None:
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        pytest.skip("OPENAI_API_KEY is not set")
    understanding = OpenAIUserUnderstanding(api_key)
    recent = [RecentLine("Person", "Ping, check the release branch.")]
    assert understanding.understand("the weather is nice to day isn't it", recent)
    assert understanding.understand("um uh hmm", recent) == ""
