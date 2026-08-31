"""Live OpenAI text completions for the computerless worker."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv

from chatticus.thin_task import TASK_TOOL_NAME, openai_task_tool
from chatticus.worker.computerless import (
    CompletionOutcome,
    FakeTextCompletionClient,
    TaskToolCall,
    TextCompletionClient,
)

DEFAULT_OPENAI_MODEL = "gpt-5.6-luna"
_OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions"
_ALLOWED_GATES = frozenset({"workspace", "browser"})
WORKER_SYSTEM_PROMPT = (
    "You are a Chatticus household teammate. "
    "If the human only wants a spoken or written answer, reply in plain text "
    "and do not call tools. "
    "Use the task tool to create, read, complete, or close durable household "
    "tasks without summoning the computer. "
    "If they ask you to use the household computer, workspace, or browser, "
    "call request_computer_capability with gate browser or workspace. "
    "Do not claim you opened a browser or read files you cannot reach."
)
COMPUTER_CAPABILITY_TOOL = {
    "type": "function",
    "function": {
        "name": "request_computer_capability",
        "description": (
            "Call only when the next useful step needs the household computer "
            "(workspace files or a browser). Do not call for a text-only reply."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "gate": {
                    "type": "string",
                    "enum": ["workspace", "browser"],
                }
            },
            "required": ["gate"],
        },
    },
}


def computerless_worker_tools() -> list[dict[str, Any]]:
    """Return first-gate tools available to the computerless worker."""
    return [openai_task_tool(), COMPUTER_CAPABILITY_TOOL]


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


def outcome_from_chat_completion(payload: dict[str, Any]) -> CompletionOutcome:
    """Map one Chat Completions response into text and optional tool calls."""
    choices = payload.get("choices") or []
    if not choices:
        raise RuntimeError("OpenAI returned no choices.")
    message = choices[0].get("message") or {}
    text = (message.get("content") or "").strip()
    wait_gate = None
    task_tool_call = None
    for call in message.get("tool_calls") or []:
        function = call.get("function") or {}
        name = function.get("name")
        try:
            arguments = json.loads(function.get("arguments") or "{}")
        except json.JSONDecodeError:
            continue
        if name == TASK_TOOL_NAME:
            action = str(arguments.get("action", "")).strip()
            if not action:
                continue
            task_arguments = {
                key: str(value)
                for key, value in arguments.items()
                if key != "action" and value is not None
            }
            task_tool_call = TaskToolCall(action=action, arguments=task_arguments)
            continue
        if name != "request_computer_capability":
            continue
        gate = arguments.get("gate")
        if gate in _ALLOWED_GATES:
            wait_gate = gate
            break
    if task_tool_call is not None:
        return CompletionOutcome(
            text=text or "I'll update the household task list.",
            task_tool_call=task_tool_call,
        )
    if wait_gate is not None:
        return CompletionOutcome(
            text=text or "Here is a draft before I need the computer.",
            wait_gate=wait_gate,
        )
    if not text:
        raise RuntimeError("OpenAI returned an empty completion.")
    return CompletionOutcome(text=text)


class OpenAITextCompletionClient:
    """One-shot Chat Completions call against OpenAI."""

    def __init__(self, api_key: str, model: str = DEFAULT_OPENAI_MODEL) -> None:
        self.api_key = api_key
        self.model = model

    def complete(self, prompt: str) -> CompletionOutcome:
        """Return the model's text answer and any computer wait gate."""
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
        return outcome_from_chat_completion(response.json())


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
