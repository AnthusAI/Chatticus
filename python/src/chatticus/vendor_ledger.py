"""Per-turn vendor spend ledger rows and observability logs."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import TYPE_CHECKING

from chatticus.vendor_prices import lookup_vendor_price

if TYPE_CHECKING:
    from chatticus.messaging.store import MessagingStore

logger = logging.getLogger("chatticus.vendor_ledger")

MILLION = Decimal("1000000")
BILLED_VIA_VENDOR = "vendor"
BILLED_VIA_AWS = "aws"

FAKE_COMPLETION_INPUT_TOKENS = 10
FAKE_COMPLETION_OUTPUT_TOKENS = 5


@dataclass(frozen=True)
class CompletionUsage:
    """Token counts from one vendor model call."""

    vendor: str
    model: str
    input_tokens: int
    output_tokens: int


@dataclass(frozen=True)
class VendorLedgerRow:
    """One durable vendor spend row for a turn."""

    tenant_id: str
    turn_id: str
    vendor: str
    model: str
    input_tokens: int
    output_tokens: int
    billed_via: str
    input_price_per_million_usd: Decimal | None
    output_price_per_million_usd: Decimal | None
    cost_usd: Decimal | None
    recorded_at: datetime


def fake_openai_completion_usage(*, model: str) -> CompletionUsage:
    """Return deterministic usage for fake completion clients."""
    return CompletionUsage(
        vendor="openai",
        model=model,
        input_tokens=FAKE_COMPLETION_INPUT_TOKENS,
        output_tokens=FAKE_COMPLETION_OUTPUT_TOKENS,
    )


def cost_usd_from_tokens(
    input_tokens: int,
    output_tokens: int,
    *,
    input_price_per_million_usd: Decimal | None,
    output_price_per_million_usd: Decimal | None,
) -> Decimal | None:
    """Compute vendor-billed dollars from token counts and frozen unit rates."""
    if input_price_per_million_usd is None or output_price_per_million_usd is None:
        return None
    if input_tokens == 0 and output_tokens == 0:
        return None
    input_cost = (
        Decimal(input_tokens) * input_price_per_million_usd / MILLION
    ).quantize(Decimal("0.00000001"))
    output_cost = (
        Decimal(output_tokens) * output_price_per_million_usd / MILLION
    ).quantize(Decimal("0.00000001"))
    return input_cost + output_cost


def record_vendor_spend(
    store: MessagingStore,
    tenant_id: str,
    turn_id: str,
    usage: CompletionUsage,
    *,
    billed_via: str,
    now: datetime | None = None,
) -> VendorLedgerRow:
    """Persist one model call and emit a JSON log derived from the written row."""
    recorded_at = now or datetime.now(tz=UTC)
    existing = store.get_vendor_ledger_row(tenant_id, turn_id)
    if existing is None:
        row = _insert_vendor_ledger_row(
            store,
            tenant_id,
            turn_id,
            usage,
            billed_via=billed_via,
            recorded_at=recorded_at,
        )
    else:
        row = _accumulate_vendor_ledger_row(
            store,
            tenant_id,
            turn_id,
            usage,
            existing=existing,
        )
    log_vendor_ledger_row(row)
    return row


def log_vendor_ledger_row(row: VendorLedgerRow) -> None:
    """Write one structured JSON log line derived from a persisted ledger row."""
    logger.info(json.dumps(ledger_log_payload(row), default=_json_default))


def ledger_log_payload(row: VendorLedgerRow) -> dict[str, object]:
    """Build the observability payload for one ledger row."""
    return {
        "event": "vendor_ledger",
        "tenant_id": row.tenant_id,
        "turn_id": row.turn_id,
        "vendor": row.vendor,
        "model": row.model,
        "input_tokens": row.input_tokens,
        "output_tokens": row.output_tokens,
        "billed_via": row.billed_via,
        "input_price_per_million_usd": row.input_price_per_million_usd,
        "output_price_per_million_usd": row.output_price_per_million_usd,
        "cost_usd": row.cost_usd,
        "recorded_at": row.recorded_at,
    }


def _insert_vendor_ledger_row(
    store: MessagingStore,
    tenant_id: str,
    turn_id: str,
    usage: CompletionUsage,
    *,
    billed_via: str,
    recorded_at: datetime,
) -> VendorLedgerRow:
    price = lookup_vendor_price(usage.vendor, usage.model)
    input_rate: Decimal | None = None
    output_rate: Decimal | None = None
    cost_usd: Decimal | None = None
    if billed_via == BILLED_VIA_VENDOR and price is not None:
        input_rate = price.input_per_million_usd
        output_rate = price.output_per_million_usd
        cost_usd = cost_usd_from_tokens(
            usage.input_tokens,
            usage.output_tokens,
            input_price_per_million_usd=input_rate,
            output_price_per_million_usd=output_rate,
        )
    row = VendorLedgerRow(
        tenant_id=tenant_id,
        turn_id=turn_id,
        vendor=usage.vendor,
        model=usage.model,
        input_tokens=usage.input_tokens,
        output_tokens=usage.output_tokens,
        billed_via=billed_via,
        input_price_per_million_usd=input_rate,
        output_price_per_million_usd=output_rate,
        cost_usd=cost_usd if billed_via == BILLED_VIA_VENDOR else None,
        recorded_at=recorded_at,
    )
    return store.insert_vendor_ledger_row(row)


def _accumulate_vendor_ledger_row(
    store: MessagingStore,
    tenant_id: str,
    turn_id: str,
    usage: CompletionUsage,
    *,
    existing: VendorLedgerRow,
) -> VendorLedgerRow:
    cost_delta: Decimal | None = None
    if (
        existing.billed_via == BILLED_VIA_VENDOR
        and existing.input_price_per_million_usd is not None
        and existing.output_price_per_million_usd is not None
    ):
        cost_delta = cost_usd_from_tokens(
            usage.input_tokens,
            usage.output_tokens,
            input_price_per_million_usd=existing.input_price_per_million_usd,
            output_price_per_million_usd=existing.output_price_per_million_usd,
        )
    return store.accumulate_vendor_ledger_usage(
        tenant_id,
        turn_id,
        input_delta=usage.input_tokens,
        output_delta=usage.output_tokens,
        cost_delta=cost_delta,
    )


def _json_default(value: object) -> object:
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, datetime):
        return value.isoformat()
    msg = f"Object of type {type(value)!r} is not JSON serializable."
    raise TypeError(msg)
