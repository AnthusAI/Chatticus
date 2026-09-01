"""Write-time vendor model prices for the per-turn spend ledger."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

VENDOR_OPENAI = "openai"

TEST_VENDOR_MODEL = "chatticus-test-model"


@dataclass(frozen=True)
class VendorPrice:
    """Per-million-token list price in United States dollars."""

    input_per_million_usd: Decimal
    output_per_million_usd: Decimal


_PRICES: dict[tuple[str, str], VendorPrice] = {}


def lookup_vendor_price(vendor: str, model: str) -> VendorPrice | None:
    """Return the list price for one vendor model when it is configured."""
    return _PRICES.get((vendor, model))


def register_vendor_price(vendor: str, model: str, price: VendorPrice) -> None:
    """Register one price for in-process tests and Gherkin steps."""
    _PRICES[(vendor, model)] = price


def clear_vendor_prices() -> None:
    """Remove every registered price. Tests call this between scenarios."""
    _PRICES.clear()
