"""Map vendor-neutral tool calls into a computerless CompletionOutcome."""

from __future__ import annotations

import json
from typing import Any

from chatticus.llm.types import CompletionOutcome, GatedToolCall, TaskToolCall
from chatticus.thin_task import TASK_TOOL_NAME
from chatticus.vendor_ledger import BILLED_VIA_VENDOR, CompletionUsage

_ALLOWED_GATES = frozenset({"workspace", "browser"})


def parse_tool_arguments(raw: Any) -> dict[str, Any]:
    """Parse a vendor arguments payload into a dict, or empty on failure."""
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str) or not raw.strip():
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def outcome_from_named_tool_calls(
    text: str,
    usage: CompletionUsage,
    calls: list[tuple[str, dict[str, Any]]],
    *,
    billed_via: str = BILLED_VIA_VENDOR,
    empty_error: str = "Model returned an empty completion.",
) -> CompletionOutcome:
    """Turn text plus (name, arguments) pairs into one worker outcome."""
    wait_gate = None
    task_tool_call = None
    gated_tool_call = None
    stripped = (text or "").strip()
    for name, arguments in calls:
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
        if name == "read_workspace":
            path = str(arguments.get("path", "")).strip()
            if path:
                gated_tool_call = GatedToolCall(
                    tool_name="read_workspace",
                    arguments={"path": path},
                )
            continue
        if name == "write_workspace":
            path = str(arguments.get("path", "")).strip()
            if path:
                gated_tool_call = GatedToolCall(
                    tool_name="write_workspace",
                    arguments={
                        "path": path,
                        "content": str(arguments.get("content", "")),
                    },
                )
            continue
        if name == "browse":
            url = str(arguments.get("url", "")).strip()
            if url:
                gated_tool_call = GatedToolCall(
                    tool_name="browse",
                    arguments={"url": url},
                )
            continue
        if name == "run_terminal":
            command = str(arguments.get("command", "")).strip()
            if command:
                cwd = str(arguments.get("cwd", "/workspace")).strip() or "/workspace"
                gated_tool_call = GatedToolCall(
                    tool_name="run_terminal",
                    arguments={"command": command, "cwd": cwd},
                )
            continue
        if name != "request_computer_capability":
            gated_tool_call = GatedToolCall(
                tool_name=str(name),
                arguments={
                    key: str(value)
                    for key, value in arguments.items()
                    if value is not None
                },
            )
            continue
        gate = arguments.get("gate")
        if gate in _ALLOWED_GATES:
            wait_gate = gate
            break
    if gated_tool_call is not None:
        return CompletionOutcome(
            text=stripped or "I'll use the granted capability.",
            usage=usage,
            billed_via=billed_via,
            gated_tool_call=gated_tool_call,
        )
    if task_tool_call is not None:
        return CompletionOutcome(
            text=stripped or "I'll update the household task list.",
            usage=usage,
            billed_via=billed_via,
            task_tool_call=task_tool_call,
        )
    if wait_gate is not None:
        return CompletionOutcome(
            text=stripped or "Here is a draft before I need the computer.",
            usage=usage,
            billed_via=billed_via,
            wait_gate=wait_gate,
        )
    if not stripped:
        raise RuntimeError(empty_error)
    return CompletionOutcome(text=stripped, usage=usage, billed_via=billed_via)
