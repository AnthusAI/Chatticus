"""Anthropic Messages completions for the computerless worker."""

from __future__ import annotations

from typing import Any

import httpx

from chatticus.llm.outcome import outcome_from_named_tool_calls, parse_tool_arguments
from chatticus.llm.prompt import WORKER_SYSTEM_PROMPT
from chatticus.llm.tools import anthropic_tools
from chatticus.llm.types import CompletionOutcome
from chatticus.vendor_ledger import BILLED_VIA_VENDOR, CompletionUsage

_ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages"
_ANTHROPIC_VERSION = "2023-06-01"


def usage_from_anthropic(payload: dict[str, Any], model: str) -> CompletionUsage:
    """Extract token usage from one Anthropic Messages response."""
    usage = payload.get("usage") or {}
    return CompletionUsage(
        vendor="anthropic",
        model=model,
        input_tokens=int(usage.get("input_tokens") or 0),
        output_tokens=int(usage.get("output_tokens") or 0),
    )


def _tool_calls_from_anthropic(
    payload: dict[str, Any],
) -> list[tuple[str, dict[str, Any]]]:
    calls: list[tuple[str, dict[str, Any]]] = []
    for block in payload.get("content") or []:
        if not isinstance(block, dict) or block.get("type") != "tool_use":
            continue
        name = str(block.get("name") or "")
        if not name:
            continue
        calls.append((name, parse_tool_arguments(block.get("input"))))
    return calls


def _text_from_anthropic(payload: dict[str, Any]) -> str:
    parts: list[str] = []
    for block in payload.get("content") or []:
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(str(block.get("text") or ""))
    return "".join(parts).strip()


def outcome_from_anthropic(
    payload: dict[str, Any],
    *,
    model: str,
) -> CompletionOutcome:
    """Map one Anthropic Messages response into text and optional tool calls."""
    return outcome_from_named_tool_calls(
        _text_from_anthropic(payload),
        usage_from_anthropic(payload, model),
        _tool_calls_from_anthropic(payload),
        billed_via=BILLED_VIA_VENDOR,
        empty_error="Anthropic returned an empty completion.",
    )


class AnthropicTextCompletionClient:
    """One-shot Messages call against Anthropic."""

    def __init__(self, api_key: str, model: str) -> None:
        self.api_key = api_key
        self.model = model

    def complete(
        self, prompt: str, *, model_id: str | None = None
    ) -> CompletionOutcome:
        """Return the model's text answer and any computer wait gate."""
        del model_id
        response = httpx.post(
            _ANTHROPIC_MESSAGES_URL,
            headers={
                "x-api-key": self.api_key,
                "anthropic-version": _ANTHROPIC_VERSION,
            },
            json={
                "model": self.model,
                "max_tokens": 256,
                "system": WORKER_SYSTEM_PROMPT,
                "messages": [{"role": "user", "content": prompt}],
                "tools": anthropic_tools(),
            },
            timeout=60.0,
        )
        response.raise_for_status()
        return outcome_from_anthropic(response.json(), model=self.model)
