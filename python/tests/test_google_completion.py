"""Gemini generateContent payload mapping for the computerless worker."""

from __future__ import annotations

from chatticus.llm.google import outcome_from_google
from chatticus.vendor_ledger import BILLED_VIA_VENDOR


def test_outcome_from_google_reads_text_and_usage() -> None:
    outcome = outcome_from_google(
        {
            "candidates": [{"content": {"parts": [{"text": "Hello from Gemini."}]}}],
            "usageMetadata": {"promptTokenCount": 6, "candidatesTokenCount": 4},
        },
        model="gemini-2.5-flash",
    )
    assert outcome.text == "Hello from Gemini."
    assert outcome.usage.vendor == "google"
    assert outcome.usage.input_tokens == 6
    assert outcome.usage.output_tokens == 4
    assert outcome.billed_via == BILLED_VIA_VENDOR
    assert outcome.wait_gate is None


def test_outcome_from_google_reads_browser_tool() -> None:
    outcome = outcome_from_google(
        {
            "candidates": [
                {
                    "content": {
                        "parts": [
                            {"text": "I will open mail next."},
                            {
                                "functionCall": {
                                    "name": "request_computer_capability",
                                    "args": {"gate": "browser"},
                                }
                            },
                        ]
                    }
                }
            ],
            "usageMetadata": {"promptTokenCount": 1, "candidatesTokenCount": 2},
        },
        model="gemini-2.5-flash",
    )
    assert outcome.wait_gate == "browser"
    assert outcome.billed_via == BILLED_VIA_VENDOR
