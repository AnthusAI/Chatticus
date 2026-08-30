"""Live OpenAI text completions for the computerless worker."""

from __future__ import annotations

import os
from pathlib import Path

import httpx
from dotenv import load_dotenv

from chatticus.worker.computerless import FakeTextCompletionClient, TextCompletionClient

DEFAULT_OPENAI_MODEL = "gpt-5.6-luna"
_OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions"


def repository_root() -> Path:
    """Return the Chattic.us repository root that holds ``.env``."""
    for parent in Path(__file__).resolve().parents:
        if (parent / ".env.example").is_file():
            return parent
    raise RuntimeError("Could not locate the Chattic.us repository root.")


def load_local_env() -> None:
    """Load ``.env`` from the repository root without overriding the process."""
    load_dotenv(repository_root() / ".env", override=False)


class OpenAITextCompletionClient:
    """One-shot Chat Completions call against OpenAI."""

    def __init__(self, api_key: str, model: str = DEFAULT_OPENAI_MODEL) -> None:
        self.api_key = api_key
        self.model = model

    def complete(self, prompt: str) -> str:
        """Return the model's text answer for a prompt."""
        response = httpx.post(
            _OPENAI_CHAT_URL,
            headers={"Authorization": f"Bearer {self.api_key}"},
            json={
                "model": self.model,
                "messages": [{"role": "user", "content": prompt}],
                "max_completion_tokens": 256,
                "reasoning_effort": "none",
            },
            timeout=60.0,
        )
        response.raise_for_status()
        payload = response.json()
        choices = payload.get("choices") or []
        if not choices:
            raise RuntimeError("OpenAI returned no choices.")
        text = (choices[0].get("message") or {}).get("content") or ""
        stripped = text.strip()
        if not stripped:
            raise RuntimeError("OpenAI returned an empty completion.")
        return stripped


def completion_client_from_env() -> TextCompletionClient:
    """Use OpenAI when ``OPENAI_API_KEY`` is set; otherwise the fake client."""
    load_local_env()
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        return FakeTextCompletionClient()
    model = os.environ.get("OPENAI_MODEL", DEFAULT_OPENAI_MODEL).strip()
    return OpenAITextCompletionClient(api_key, model or DEFAULT_OPENAI_MODEL)
