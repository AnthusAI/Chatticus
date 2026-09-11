"""Amazon Bedrock Converse completions for the computerless worker."""

from __future__ import annotations

import os
from collections.abc import Callable
from typing import Any

from chatticus.llm.outcome import outcome_from_named_tool_calls, parse_tool_arguments
from chatticus.llm.prompt import WORKER_SYSTEM_PROMPT
from chatticus.llm.tools import bedrock_tool_config
from chatticus.llm.types import CompletionOutcome
from chatticus.vendor_ledger import BILLED_VIA_AWS, CompletionUsage

DEFAULT_BEDROCK_REGION = "us-east-1"


def usage_from_converse(payload: dict[str, Any], model: str) -> CompletionUsage:
    """Extract token usage from one Converse response."""
    usage = payload.get("usage") or {}
    return CompletionUsage(
        vendor="bedrock",
        model=model,
        input_tokens=int(usage.get("inputTokens") or 0),
        output_tokens=int(usage.get("outputTokens") or 0),
    )


def _tool_calls_from_converse(
    payload: dict[str, Any],
) -> list[tuple[str, dict[str, Any]]]:
    message = (payload.get("output") or {}).get("message") or {}
    calls: list[tuple[str, dict[str, Any]]] = []
    for block in message.get("content") or []:
        tool_use = block.get("toolUse") if isinstance(block, dict) else None
        if not tool_use:
            continue
        name = str(tool_use.get("name") or "")
        if not name:
            continue
        calls.append((name, parse_tool_arguments(tool_use.get("input"))))
    return calls


def _text_from_converse(payload: dict[str, Any]) -> str:
    message = (payload.get("output") or {}).get("message") or {}
    parts: list[str] = []
    for block in message.get("content") or []:
        if isinstance(block, dict) and block.get("text"):
            parts.append(str(block["text"]))
    return "".join(parts).strip()


def outcome_from_converse(
    payload: dict[str, Any],
    *,
    model: str,
) -> CompletionOutcome:
    """Map one Converse response into text and optional tool calls."""
    return outcome_from_named_tool_calls(
        _text_from_converse(payload),
        usage_from_converse(payload, model),
        _tool_calls_from_converse(payload),
        billed_via=BILLED_VIA_AWS,
        empty_error="Bedrock returned an empty completion.",
    )


class BedrockTextCompletionClient:
    """One-shot Converse call against Amazon Bedrock."""

    def __init__(
        self,
        model: str,
        *,
        region: str | None = None,
        converse: Callable[..., dict[str, Any]] | None = None,
    ) -> None:
        self.model = model
        self.region = region or os.environ.get("AWS_REGION", DEFAULT_BEDROCK_REGION)
        self._converse = converse

    def complete(
        self, prompt: str, *, model_id: str | None = None
    ) -> CompletionOutcome:
        """Return the model's text answer and any computer wait gate."""
        del model_id
        payload = self._call_converse(prompt)
        return outcome_from_converse(payload, model=self.model)

    def _call_converse(self, prompt: str) -> dict[str, Any]:
        kwargs = {
            "modelId": self.model,
            "system": [{"text": WORKER_SYSTEM_PROMPT}],
            "messages": [
                {"role": "user", "content": [{"text": prompt}]},
            ],
            "toolConfig": bedrock_tool_config(),
            "inferenceConfig": {"maxTokens": 256},
        }
        if self._converse is not None:
            return self._converse(**kwargs)
        import boto3

        client = boto3.client("bedrock-runtime", region_name=self.region)
        return client.converse(**kwargs)
