"""Dispatch first-gate model tools through ThinTurn HTTP sinks."""

from __future__ import annotations

from dataclasses import dataclass

from chatticus.http.client import GatedToolHttpError, HttpTurnClient

FIRST_GATE_MODEL_TOOLS = frozenset({"read_workspace", "browse"})


@dataclass(frozen=True)
class GatedToolCall:
    """One model-requested first-gate or egress tool invocation."""

    tool_name: str
    arguments: dict[str, str]


@dataclass(frozen=True)
class ToolDispatchResult:
    """Outcome of one gated tool dispatch through HTTP."""

    denied: bool
    reason: str
    content: str | None = None


def dispatch_gated_tool(
    turn_client: HttpTurnClient,
    *,
    turn_id: str,
    user_id: str,
    call: GatedToolCall,
) -> ToolDispatchResult:
    """Route one model tool call through HttpTurnClient without importing sinks."""
    if call.tool_name == "read_workspace":
        path = call.arguments.get("path", "").strip()
        if not path:
            return ToolDispatchResult(denied=True, reason="path is required")
        try:
            payload = turn_client.read_workspace_gated(turn_id, user_id, path)
        except GatedToolHttpError as error:
            return ToolDispatchResult(denied=True, reason=error.reason)
        content = payload.get("content")
        return ToolDispatchResult(
            denied=False,
            reason="",
            content="" if content is None else str(content),
        )
    if call.tool_name == "browse":
        url = call.arguments.get("url", "").strip()
        if not url:
            return ToolDispatchResult(denied=True, reason="url is required")
        try:
            turn_client.authorize_browse(turn_id, url)
        except GatedToolHttpError as error:
            return ToolDispatchResult(denied=True, reason=error.reason)
        return ToolDispatchResult(denied=False, reason="", content=url)
    try:
        turn_client.deny_model_tool(turn_id, call.tool_name, call.arguments)
    except GatedToolHttpError as error:
        return ToolDispatchResult(denied=True, reason=error.reason)
    return ToolDispatchResult(denied=False, reason="")
