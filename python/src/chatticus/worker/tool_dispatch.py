"""Dispatch first-gate model tools through ThinTurn HTTP sinks."""

from __future__ import annotations

from dataclasses import dataclass

from chatticus.http.client import GatedToolHttpError, HttpTurnClient
from chatticus.llm.types import GatedToolCall

FIRST_GATE_MODEL_TOOLS = frozenset({"browse"})

COMPUTER_ESCALATION_TOOLS = frozenset(
    {"read_workspace", "write_workspace", "run_terminal"}
)


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
