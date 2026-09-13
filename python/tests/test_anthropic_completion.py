"""Anthropic Messages payload mapping for the computerless worker."""

from __future__ import annotations

from chatticus.llm.anthropic import outcome_from_anthropic
from chatticus.vendor_ledger import BILLED_VIA_VENDOR


def test_outcome_from_anthropic_reads_text_and_usage() -> None:
    outcome = outcome_from_anthropic(
        {
            "content": [{"type": "text", "text": "Hello from Anthropic."}],
            "usage": {"input_tokens": 8, "output_tokens": 3},
        },
        model="claude-sonnet-4-5",
    )
    assert outcome.text == "Hello from Anthropic."
    assert outcome.usage.vendor == "anthropic"
    assert outcome.usage.input_tokens == 8
    assert outcome.usage.output_tokens == 3
    assert outcome.billed_via == BILLED_VIA_VENDOR
    assert outcome.wait_gate is None


def test_outcome_from_anthropic_reads_browser_tool() -> None:
    outcome = outcome_from_anthropic(
        {
            "content": [
                {"type": "text", "text": "I will open mail next."},
                {
                    "type": "tool_use",
                    "name": "request_computer_capability",
                    "input": {"gate": "browser"},
                },
            ],
            "usage": {"input_tokens": 1, "output_tokens": 2},
        },
        model="claude-sonnet-4-5",
    )
    assert outcome.wait_gate == "browser"
    assert outcome.billed_via == BILLED_VIA_VENDOR
