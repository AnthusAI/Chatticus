"""Shared completion types used by every vendor adapter and the worker."""

from __future__ import annotations

from dataclasses import dataclass

from chatticus.vendor_ledger import BILLED_VIA_VENDOR, CompletionUsage


@dataclass(frozen=True)
class TaskToolCall:
    """One structured task-tool invocation from the model."""

    action: str
    arguments: dict[str, str]


@dataclass(frozen=True)
class GatedToolCall:
    """One model-requested first-gate or egress tool invocation."""

    tool_name: str
    arguments: dict[str, str]


@dataclass(frozen=True)
class CompletionOutcome:
    """One model step: text to stream, and optional tool side effects."""

    text: str
    usage: CompletionUsage
    billed_via: str = BILLED_VIA_VENDOR
    wait_gate: str | None = None
    task_tool_call: TaskToolCall | None = None
    gated_tool_call: GatedToolCall | None = None
