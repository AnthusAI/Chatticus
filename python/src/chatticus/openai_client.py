"""Shared OpenAI access: endpoint, API key resolution, and per-model settings.

A leaf module: it imports nothing from the worker or HTTP packages, so any
part of Chatticus that calls OpenAI (the computerless worker, the
understand-the-user step) can depend on it without import cycles.
"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

from chatticus.vendor_ledger import CompletionUsage

logger = logging.getLogger(__name__)

OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions"

_FIRST_GENERATION_GPT_5_MODEL = re.compile(
    r"^gpt-5(-mini|-nano)?(-\d{4}-\d{2}-\d{2})?$"
)


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


def api_key_from_ssm() -> str:
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


def lowest_reasoning_effort(model: str) -> str:
    """Return the least reasoning effort ``model`` accepts.

    The first GPT-5 models (gpt-5, gpt-5-mini, gpt-5-nano) accept ``minimal``
    but not ``none``; later models accept ``none`` but not ``minimal``.
    """
    return "minimal" if _FIRST_GENERATION_GPT_5_MODEL.match(model) else "none"


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
