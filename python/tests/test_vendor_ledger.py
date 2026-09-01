"""Tests for the per-turn vendor spend ledger."""

from __future__ import annotations

import json
import logging
from decimal import Decimal

import boto3
import pytest
from moto import mock_aws

from chatticus.messaging.store import (
    DynamoMessagingStore,
    InMemoryMessagingStore,
    create_messaging_table,
)
from chatticus.vendor_ledger import (
    BILLED_VIA_AWS,
    BILLED_VIA_VENDOR,
    CompletionUsage,
    cost_usd_from_tokens,
    ledger_log_payload,
    record_vendor_spend,
)
from chatticus.vendor_prices import (
    TEST_VENDOR_MODEL,
    VendorPrice,
    clear_vendor_prices,
    lookup_vendor_price,
    register_vendor_price,
)
from chatticus.worker.openai_completion import (
    DEFAULT_OPENAI_MODEL,
    outcome_from_chat_completion,
    usage_from_chat_completion,
)


@pytest.fixture(autouse=True)
def _clear_prices() -> None:
    clear_vendor_prices()
    yield
    clear_vendor_prices()


def test_production_price_table_omits_default_openai_model() -> None:
    assert lookup_vendor_price("openai", DEFAULT_OPENAI_MODEL) is None


def test_cost_usd_from_tokens_uses_decimal_math() -> None:
    cost = cost_usd_from_tokens(
        10,
        5,
        input_price_per_million_usd=Decimal("2.00"),
        output_price_per_million_usd=Decimal("4.00"),
    )
    assert cost == Decimal("0.00004000")


def test_record_vendor_spend_writes_known_test_model_with_frozen_rates() -> None:
    register_vendor_price(
        "openai",
        TEST_VENDOR_MODEL,
        VendorPrice(Decimal("2.00"), Decimal("4.00")),
    )
    store = InMemoryMessagingStore()
    row = record_vendor_spend(
        store,
        "anthus",
        "turn-1",
        CompletionUsage("openai", TEST_VENDOR_MODEL, 10, 5),
        billed_via=BILLED_VIA_VENDOR,
    )
    assert row.input_tokens == 10
    assert row.output_tokens == 5
    assert row.input_price_per_million_usd == Decimal("2.00")
    assert row.output_price_per_million_usd == Decimal("4.00")
    assert row.cost_usd == Decimal("0.00004000")


def test_record_vendor_spend_unknown_model_has_null_dollars() -> None:
    store = InMemoryMessagingStore()
    row = record_vendor_spend(
        store,
        "anthus",
        "turn-1",
        CompletionUsage("openai", "unknown-model-id", 10, 5),
        billed_via=BILLED_VIA_VENDOR,
    )
    assert row.input_tokens == 10
    assert row.cost_usd is None
    assert row.input_price_per_million_usd is None


def test_record_vendor_spend_aws_billing_forces_null_cost() -> None:
    register_vendor_price(
        "openai",
        TEST_VENDOR_MODEL,
        VendorPrice(Decimal("2.00"), Decimal("4.00")),
    )
    store = InMemoryMessagingStore()
    row = record_vendor_spend(
        store,
        "anthus",
        "turn-1",
        CompletionUsage("openai", TEST_VENDOR_MODEL, 10, 5),
        billed_via=BILLED_VIA_AWS,
    )
    assert row.input_tokens == 10
    assert row.cost_usd is None


def test_retry_accumulation_uses_frozen_first_write_rates() -> None:
    register_vendor_price(
        "openai",
        TEST_VENDOR_MODEL,
        VendorPrice(Decimal("2.00"), Decimal("4.00")),
    )
    store = InMemoryMessagingStore()
    record_vendor_spend(
        store,
        "anthus",
        "turn-1",
        CompletionUsage("openai", TEST_VENDOR_MODEL, 10, 5),
        billed_via=BILLED_VIA_VENDOR,
    )
    register_vendor_price(
        "openai",
        TEST_VENDOR_MODEL,
        VendorPrice(Decimal("99.00"), Decimal("99.00")),
    )
    row = record_vendor_spend(
        store,
        "anthus",
        "turn-1",
        CompletionUsage("openai", TEST_VENDOR_MODEL, 3, 2),
        billed_via=BILLED_VIA_VENDOR,
    )
    assert row.input_tokens == 13
    assert row.output_tokens == 7
    assert row.input_price_per_million_usd == Decimal("2.00")
    assert row.output_price_per_million_usd == Decimal("4.00")
    assert row.cost_usd == Decimal("0.00005400")


def test_missing_openai_usage_still_records_zero_tokens(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.WARNING):
        usage = usage_from_chat_completion({"choices": []}, DEFAULT_OPENAI_MODEL)
    assert usage.input_tokens == 0
    assert usage.output_tokens == 0


def test_outcome_from_chat_completion_includes_usage() -> None:
    outcome = outcome_from_chat_completion(
        {
            "usage": {"prompt_tokens": 12, "completion_tokens": 3},
            "choices": [{"message": {"content": "Hello there."}}],
        },
        model=TEST_VENDOR_MODEL,
    )
    assert outcome.usage.input_tokens == 12
    assert outcome.usage.output_tokens == 3


@mock_aws
def test_dynamo_vendor_ledger_round_trip() -> None:
    register_vendor_price(
        "openai",
        TEST_VENDOR_MODEL,
        VendorPrice(Decimal("1.00"), Decimal("2.00")),
    )
    client = boto3.client("dynamodb", region_name="us-east-1")
    table_name = "vendor-ledger-test"
    create_messaging_table(client, table_name)
    store = DynamoMessagingStore(table_name, client=client)
    row = record_vendor_spend(
        store,
        "anthus",
        "turn-1",
        CompletionUsage("openai", TEST_VENDOR_MODEL, 1000, 500),
        billed_via=BILLED_VIA_VENDOR,
    )
    loaded = store.get_vendor_ledger_row("anthus", "turn-1")
    assert loaded == row
    assert isinstance(loaded.cost_usd, Decimal)


def test_log_payload_serializes_decimals(
    caplog: pytest.LogCaptureFixture,
) -> None:
    register_vendor_price(
        "openai",
        TEST_VENDOR_MODEL,
        VendorPrice(Decimal("2.00"), Decimal("4.00")),
    )
    store = InMemoryMessagingStore()
    with caplog.at_level(logging.INFO, logger="chatticus.vendor_ledger"):
        row = record_vendor_spend(
            store,
            "anthus",
            "turn-1",
            CompletionUsage("openai", TEST_VENDOR_MODEL, 10, 5),
            billed_via=BILLED_VIA_VENDOR,
        )
    payload = ledger_log_payload(row)
    encoded = json.dumps(payload, default=lambda value: format(value, "f"))
    assert '"cost_usd": "0.00004000"' in encoded
    assert any("vendor_ledger" in record.message for record in caplog.records)
