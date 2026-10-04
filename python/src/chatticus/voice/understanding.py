"""The understand-the-user step for spoken lines.

Speech-to-text in the browser makes mistakes: misheard words, missing
punctuation, names spelled the way they sound. Before a spoken line becomes a
message, a small, cheap model reads the raw transcript and the recent
conversation and returns what the member most likely said. It does not answer
the line; it only repairs it, or returns nothing when the line carries no
message (filler, a cough, the room talking).
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Protocol

import httpx

DEFAULT_UNDERSTANDING_MODEL = "gpt-5-nano"
RECENT_LINES_FOR_UNDERSTANDING = 10

UNDERSTANDING_SYSTEM_PROMPT = (
    "You repair voice transcripts. The user message gives a speech-to-text "
    "transcript of one thing a person just said to an AI teammate, plus the "
    "recent conversation. The transcript may be full of recognition errors: "
    "misheard words, words split or joined wrongly, missing punctuation, names "
    "spelled the way they sound.\n"
    "Rules:\n"
    "1. Return what the person most likely said, as one clean sentence or a few, "
    "with normal capitalization and punctuation, ending with a period or "
    "question mark.\n"
    "2. Keep their wording wherever it is plausible. Fix only what was "
    "misheard. Use the conversation to resolve misheard names and terms.\n"
    "3. Never answer the person, never add requests, details or politeness they "
    "did not say, and never drop part of what they said.\n"
    "4. Any real words are a message, even small talk or a topic unrelated to "
    "the conversation. Return an empty string only when the transcript has no "
    "real words at all (only filler such as um, uh, hmm, or noise).\n"
    "Examples:\n"
    '- "ping tell me some thing" -> "Ping, tell me something."\n'
    '- "the weather is nice to day isn\'t it" -> '
    '"The weather is nice today, isn\'t it?"\n'
    '- "um uh" -> ""\n'
    'Reply with JSON only: {"understood": "..."}.'
)


@dataclass(frozen=True)
class RecentLine:
    """One recent line of the conversation, as context for understanding."""

    speaker: str
    text: str


class UserUnderstanding(Protocol):
    """Turns a raw spoken transcript into what the member most likely said."""

    def understand(self, transcript: str, recent: list[RecentLine]) -> str:
        """Return the understood text, or an empty string when nothing was meant."""


class PassthroughUserUnderstanding:
    """Used when no model is configured: the transcript is taken as said."""

    def understand(self, transcript: str, recent: list[RecentLine]) -> str:
        """Return the transcript with surrounding whitespace removed."""
        return transcript.strip()


def understanding_prompt(transcript: str, recent: list[RecentLine]) -> str:
    """Build the user message for the understand-the-user model.

    :param transcript: The raw speech-to-text line.
    :param recent: Recent conversation lines, oldest first.
    :returns: The prompt text.
    """
    conversation = "\n".join(f"{line.speaker}: {line.text}" for line in recent)
    return (
        "Recent conversation (oldest first):\n"
        f"{conversation or '(none)'}\n\n"
        f"Transcript of what the person just said:\n{transcript}"
    )


def understood_text_from_completion(payload: dict) -> str:
    """Extract the understood text from a Chat Completions response.

    :param payload: The decoded response body.
    :returns: The understood text, empty when the model found no message.
    :raises ValueError: If the response does not carry the expected JSON.
    """
    content = payload["choices"][0]["message"].get("content") or ""
    parsed = json.loads(content)
    understood = parsed.get("understood")
    if not isinstance(understood, str):
        raise ValueError("Understanding response is missing 'understood'.")
    return understood.strip()


class OpenAIUserUnderstanding:
    """Understand-the-user step on an OpenAI chat model."""

    def __init__(self, api_key: str, model: str = DEFAULT_UNDERSTANDING_MODEL) -> None:
        self.api_key = api_key
        self.model = model

    def understand(self, transcript: str, recent: list[RecentLine]) -> str:
        """Return what the member most likely said, or an empty string."""
        from chatticus.worker.openai_completion import (
            _OPENAI_CHAT_URL,
            lowest_reasoning_effort,
        )

        response = httpx.post(
            _OPENAI_CHAT_URL,
            headers={"Authorization": f"Bearer {self.api_key}"},
            json={
                "model": self.model,
                "messages": [
                    {"role": "system", "content": UNDERSTANDING_SYSTEM_PROMPT},
                    {
                        "role": "user",
                        "content": understanding_prompt(transcript, recent),
                    },
                ],
                "response_format": {"type": "json_object"},
                "max_completion_tokens": 400,
                "reasoning_effort": lowest_reasoning_effort(self.model),
            },
            timeout=30.0,
        )
        response.raise_for_status()
        return understood_text_from_completion(response.json())


def user_understanding_from_env() -> UserUnderstanding:
    """Use OpenAI when a key is available; otherwise take transcripts as said."""
    from chatticus.worker.openai_completion import _api_key_from_ssm, load_local_env

    load_local_env()
    api_key = os.environ.get("OPENAI_API_KEY", "").strip() or _api_key_from_ssm()
    if not api_key:
        return PassthroughUserUnderstanding()
    model = (
        os.environ.get(
            "OPENAI_UNDERSTANDING_MODEL", DEFAULT_UNDERSTANDING_MODEL
        ).strip()
        or DEFAULT_UNDERSTANDING_MODEL
    )
    return OpenAIUserUnderstanding(api_key, model)
