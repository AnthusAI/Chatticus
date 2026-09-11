"""Canonical computerless tool specs, translated at each vendor adapter."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from chatticus.thin_task import TASK_TOOL_NAME


@dataclass(frozen=True)
class ToolSpec:
    """One worker tool in Chatticus shape, not a vendor wire format."""

    name: str
    description: str
    parameters: dict[str, Any]


_TASK_TOOL = ToolSpec(
    name=TASK_TOOL_NAME,
    description=(
        "Create, read, complete, or close a durable household task. "
        "Use for job tracking without summoning the computer."
    ),
    parameters={
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["create", "get", "complete", "close"],
            },
            "title": {"type": "string", "description": "Required for create."},
            "task_id": {
                "type": "string",
                "description": "Required for get, complete, and close.",
            },
            "evidence": {
                "type": "string",
                "description": "Required for complete.",
            },
            "reason": {"type": "string", "description": "Required for close."},
        },
        "required": ["action"],
    },
)

_READ_WORKSPACE_TOOL = ToolSpec(
    name="read_workspace",
    description="Read one household workspace file when the task grant allows it.",
    parameters={
        "type": "object",
        "properties": {"path": {"type": "string"}},
        "required": ["path"],
    },
)

_WRITE_WORKSPACE_TOOL = ToolSpec(
    name="write_workspace",
    description="Write one household workspace file when the task grant allows it.",
    parameters={
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "content": {"type": "string"},
        },
        "required": ["path", "content"],
    },
)

_RUN_TERMINAL_TOOL = ToolSpec(
    name="run_terminal",
    description="Run one granted shell command on the household computer workspace.",
    parameters={
        "type": "object",
        "properties": {
            "command": {"type": "string"},
            "cwd": {"type": "string"},
        },
        "required": ["command"],
    },
)

_BROWSE_TOOL = ToolSpec(
    name="browse",
    description="Authorize fetching one granted web origin.",
    parameters={
        "type": "object",
        "properties": {"url": {"type": "string"}},
        "required": ["url"],
    },
)

_COMPUTER_CAPABILITY_TOOL = ToolSpec(
    name="request_computer_capability",
    description=(
        "Call only when the next useful step needs the household computer "
        "(workspace files or a browser). Do not call for a text-only reply."
    ),
    parameters={
        "type": "object",
        "properties": {
            "gate": {"type": "string", "enum": ["workspace", "browser"]},
        },
        "required": ["gate"],
    },
)


def computerless_tool_specs() -> tuple[ToolSpec, ...]:
    """Return first-gate tools shared by every completion adapter."""
    return (
        _TASK_TOOL,
        _READ_WORKSPACE_TOOL,
        _WRITE_WORKSPACE_TOOL,
        _RUN_TERMINAL_TOOL,
        _BROWSE_TOOL,
        _COMPUTER_CAPABILITY_TOOL,
    )


def openai_function_tools(
    specs: tuple[ToolSpec, ...] | None = None,
) -> list[dict[str, Any]]:
    """Translate canonical specs into OpenAI Chat Completions function tools."""
    return [
        {
            "type": "function",
            "function": {
                "name": spec.name,
                "description": spec.description,
                "parameters": spec.parameters,
            },
        }
        for spec in (specs or computerless_tool_specs())
    ]


def bedrock_tool_config(specs: tuple[ToolSpec, ...] | None = None) -> dict[str, Any]:
    """Translate canonical specs into a Bedrock Converse toolConfig."""
    return {
        "tools": [
            {
                "toolSpec": {
                    "name": spec.name,
                    "description": spec.description,
                    "inputSchema": {"json": spec.parameters},
                }
            }
            for spec in (specs or computerless_tool_specs())
        ]
    }


def anthropic_tools(specs: tuple[ToolSpec, ...] | None = None) -> list[dict[str, Any]]:
    """Translate canonical specs into Anthropic Messages tools."""
    return [
        {
            "name": spec.name,
            "description": spec.description,
            "input_schema": spec.parameters,
        }
        for spec in (specs or computerless_tool_specs())
    ]


def google_function_declarations(
    specs: tuple[ToolSpec, ...] | None = None,
) -> list[dict[str, Any]]:
    """Translate canonical specs into Gemini functionDeclarations."""
    return [
        {
            "name": spec.name,
            "description": spec.description,
            "parameters": spec.parameters,
        }
        for spec in (specs or computerless_tool_specs())
    ]
