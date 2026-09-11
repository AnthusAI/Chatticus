"""Live OpenAI text completions for the computerless worker."""

from __future__ import annotations

import logging
from typing import Any

import httpx

from chatticus.llm.local_env import load_local_env, repository_root
from chatticus.llm.outcome import outcome_from_named_tool_calls, parse_tool_arguments
from chatticus.llm.prompt import WORKER_SYSTEM_PROMPT
from chatticus.llm.tools import openai_function_tools
from chatticus.llm.types import CompletionOutcome
from chatticus.vendor_ledger import BILLED_VIA_VENDOR, CompletionUsage

logger = logging.getLogger("chatticus.worker.openai")

DEFAULT_OPENAI_MODEL = "gpt-5.6-luna"
_OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions"


def computerless_worker_tools() -> list[dict[str, Any]]:
    """Return first-gate tools in OpenAI Chat Completions shape."""
    return openai_function_tools()


def usage_from_chat_completion(payload: dict[str, Any], model: str) -> CompletionUsage:
    """Extract token usage from one Chat Completions response."""
    usage = payload.get("usage")
    if not usage:
        logger.warning(
            "openai_response_missing_usage model=%s",
            model,
        )
        return CompletionUsage(
            vendor="openai",
            model=model,
            input_tokens=0,
            output_tokens=0,
        )
    return CompletionUsage(
        vendor="openai",
        model=model,
        input_tokens=int(usage.get("prompt_tokens") or 0),
        output_tokens=int(usage.get("completion_tokens") or 0),
    )


def _tool_calls_from_chat_completion(
    payload: dict[str, Any],
) -> list[tuple[str, dict[str, Any]]]:
    choices = payload.get("choices") or []
    if not choices:
        return []
    message = choices[0].get("message") or {}
    calls: list[tuple[str, dict[str, Any]]] = []
    for call in message.get("tool_calls") or []:
        function = call.get("function") or {}
        name = function.get("name")
        if not name:
            continue
        calls.append((str(name), parse_tool_arguments(function.get("arguments"))))
    return calls


def _text_from_chat_completion(payload: dict[str, Any]) -> str:
    choices = payload.get("choices") or []
    if not choices:
        return ""
    message = choices[0].get("message") or {}
    return (message.get("content") or "").strip()


def outcome_from_chat_completion(
    payload: dict[str, Any],
    *,
    model: str,
) -> CompletionOutcome:
    """Map one Chat Completions response into text and optional tool calls."""
    choices = payload.get("choices") or []
    if not choices:
        raise RuntimeError("OpenAI returned no choices.")
    return outcome_from_named_tool_calls(
        _text_from_chat_completion(payload),
        usage_from_chat_completion(payload, model),
        _tool_calls_from_chat_completion(payload),
        billed_via=BILLED_VIA_VENDOR,
        empty_error="OpenAI returned an empty completion.",
    )


class OpenAITextCompletionClient:
    """One-shot Chat Completions call against OpenAI."""

    def __init__(self, api_key: str, model: str = DEFAULT_OPENAI_MODEL) -> None:
        self.api_key = api_key
        self.model = model

    def complete(
        self, prompt: str, *, model_id: str | None = None
    ) -> CompletionOutcome:
        """Return the model's text answer and any computer wait gate."""
        del model_id
        response = httpx.post(
            _OPENAI_CHAT_URL,
            headers={"Authorization": f"Bearer {self.api_key}"},
            json={
                "model": self.model,
                "messages": [
                    {"role": "system", "content": WORKER_SYSTEM_PROMPT},
                    {"role": "user", "content": prompt},
                ],
                "tools": computerless_worker_tools(),
                "tool_choice": "auto",
                "max_completion_tokens": 256,
                "reasoning_effort": "none",
            },
            timeout=60.0,
        )
        response.raise_for_status()
        return outcome_from_chat_completion(response.json(), model=self.model)


def completion_client_from_env():
    """Route to whichever vendors this deployment's credentials can call."""
    from chatticus.llm.catalog import catalog_from_credentials
    from chatticus.llm.credentials import (
        credentials_from_env,
        default_model_id_from_env,
    )
    from chatticus.llm.router import CatalogCompletionClient
    from chatticus.worker.computerless import FakeTextCompletionClient

    load_local_env()
    credentials = credentials_from_env()
    catalog = catalog_from_credentials(
        credentials, default_model_id=default_model_id_from_env()
    )
    if not catalog.available():
        return FakeTextCompletionClient()
    return CatalogCompletionClient(catalog, credentials)


__all__ = [
    "DEFAULT_OPENAI_MODEL",
    "WORKER_SYSTEM_PROMPT",
    "OpenAITextCompletionClient",
    "completion_client_from_env",
    "computerless_worker_tools",
    "load_local_env",
    "outcome_from_chat_completion",
    "repository_root",
    "usage_from_chat_completion",
]
