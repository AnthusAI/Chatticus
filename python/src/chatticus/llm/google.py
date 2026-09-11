"""Google Gemini completions for the computerless worker."""

from __future__ import annotations

from typing import Any

import httpx

from chatticus.llm.outcome import outcome_from_named_tool_calls, parse_tool_arguments
from chatticus.llm.prompt import WORKER_SYSTEM_PROMPT
from chatticus.llm.tools import google_function_declarations
from chatticus.llm.types import CompletionOutcome
from chatticus.vendor_ledger import BILLED_VIA_VENDOR, CompletionUsage

_GEMINI_GENERATE_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
)


def usage_from_google(payload: dict[str, Any], model: str) -> CompletionUsage:
    """Extract token usage from one Gemini generateContent response."""
    usage = payload.get("usageMetadata") or {}
    return CompletionUsage(
        vendor="google",
        model=model,
        input_tokens=int(usage.get("promptTokenCount") or 0),
        output_tokens=int(usage.get("candidatesTokenCount") or 0),
    )


def _tool_calls_from_google(
    payload: dict[str, Any],
) -> list[tuple[str, dict[str, Any]]]:
    candidates = payload.get("candidates") or []
    if not candidates:
        return []
    content = candidates[0].get("content") or {}
    calls: list[tuple[str, dict[str, Any]]] = []
    for part in content.get("parts") or []:
        call = part.get("functionCall") if isinstance(part, dict) else None
        if not call:
            continue
        name = str(call.get("name") or "")
        if not name:
            continue
        calls.append((name, parse_tool_arguments(call.get("args"))))
    return calls


def _text_from_google(payload: dict[str, Any]) -> str:
    candidates = payload.get("candidates") or []
    if not candidates:
        return ""
    content = candidates[0].get("content") or {}
    parts: list[str] = []
    for part in content.get("parts") or []:
        if isinstance(part, dict) and part.get("text"):
            parts.append(str(part["text"]))
    return "".join(parts).strip()


def outcome_from_google(payload: dict[str, Any], *, model: str) -> CompletionOutcome:
    """Map one Gemini response into text and optional tool calls."""
    return outcome_from_named_tool_calls(
        _text_from_google(payload),
        usage_from_google(payload, model),
        _tool_calls_from_google(payload),
        billed_via=BILLED_VIA_VENDOR,
        empty_error="Google returned an empty completion.",
    )


class GoogleTextCompletionClient:
    """One-shot generateContent call against Gemini."""

    def __init__(self, api_key: str, model: str) -> None:
        self.api_key = api_key
        self.model = model

    def complete(
        self, prompt: str, *, model_id: str | None = None
    ) -> CompletionOutcome:
        """Return the model's text answer and any computer wait gate."""
        del model_id
        url = _GEMINI_GENERATE_URL.format(model=self.model)
        response = httpx.post(
            url,
            params={"key": self.api_key},
            json={
                "systemInstruction": {"parts": [{"text": WORKER_SYSTEM_PROMPT}]},
                "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                "tools": [{"functionDeclarations": google_function_declarations()}],
                "generationConfig": {"maxOutputTokens": 256},
            },
            timeout=60.0,
        )
        response.raise_for_status()
        return outcome_from_google(response.json(), model=self.model)
