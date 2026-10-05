"""Budget rollup row types."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal


@dataclass(frozen=True)
class BudgetAlertEvent:
    """One durable alert recorded on a rollup row."""

    source: str
    fired_at: datetime
    detail: str


@dataclass(frozen=True)
class BudgetRollupRow:
    """One org-environment-day or account-day rollup row."""

    tenant_id: str
    environment: str
    rollup_date: date
    aws_cost_usd: Decimal | None
    vendor_cost_usd: Decimal
    combined_report_usd: Decimal | None
    ce_status: str
    alert_events: tuple[BudgetAlertEvent, ...]
    updated_at: datetime
