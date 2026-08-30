"""Live OpenAI text completions for the computerless worker."""

from __future__ import annotations

import os
from pathlib import Path

import httpx
from dotenv import load_dotenv

from chatticus.worker.computerless import FakeTextCompletionClient, TextCompletionClient

DEFAULT_OPENAI_MODEL = "gpt-5.6-luna"
_OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions"


def repository_root() -> Path | None:
    """Return the Chattic.us repository root that holds ``.env``, if present."""
    for parent in Path(__file__).resolve().parents:
        if (parent / ".env.example").is_file():
            return parent
    return None


def load_local_env() -> None:
    """Load ``.env`` from the repository root without overriding the process."""
    root = repository_root()
    if root is None:
        return
    load_dotenv(root / ".env", override=False)


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


def _api_key_from_ssm() -> str:
    """Load OPENAI_API_KEY from SSM when Lambda does not inject it."""
    parameter_name = os.environ.get("OPENAI_API_KEY_PARAMETER", "").strip()
    if not parameter_name:
        return ""
    import boto3

    response = boto3.client("ssm").get_parameter(
        Name=parameter_name,
        WithDecryption=True,
    )
    return str(response["Parameter"]["Value"]).strip()


def completion_client_from_env() -> TextCompletionClient:
    """Use OpenAI when ``OPENAI_API_KEY`` is set; otherwise the fake client."""
    load_local_env()
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        api_key = _api_key_from_ssm()
    if not api_key:
        return FakeTextCompletionClient()
    model = os.environ.get("OPENAI_MODEL", DEFAULT_OPENAI_MODEL).strip()
    return OpenAITextCompletionClient(api_key, model or DEFAULT_OPENAI_MODEL)
