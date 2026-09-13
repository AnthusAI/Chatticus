"""Bedrock Converse payload mapping for the computerless worker."""

from __future__ import annotations

from chatticus.llm.bedrock import outcome_from_converse
from chatticus.vendor_ledger import BILLED_VIA_AWS


def test_outcome_from_converse_reads_text_and_usage() -> None:
    outcome = outcome_from_converse(
        {
            "output": {"message": {"content": [{"text": "Hello from Bedrock."}]}},
            "usage": {"inputTokens": 11, "outputTokens": 4},
        },
        model="anthropic.claude-sonnet-4-5",
    )
    assert outcome.text == "Hello from Bedrock."
    assert outcome.usage.vendor == "bedrock"
    assert outcome.usage.input_tokens == 11
    assert outcome.usage.output_tokens == 4
    assert outcome.billed_via == BILLED_VIA_AWS
    assert outcome.wait_gate is None


def test_outcome_from_converse_reads_browser_tool() -> None:
    outcome = outcome_from_converse(
        {
            "output": {
                "message": {
                    "content": [
                        {"text": "I will open mail next."},
                        {
                            "toolUse": {
                                "name": "request_computer_capability",
                                "input": {"gate": "browser"},
                            }
                        },
                    ]
                }
            },
            "usage": {"inputTokens": 1, "outputTokens": 2},
        },
        model="anthropic.claude-sonnet-4-5",
    )
    assert outcome.wait_gate == "browser"
    assert outcome.billed_via == BILLED_VIA_AWS
