"""Unit tests for organization month-to-date spend metering."""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal

from chatticus.budget_rollup.models import BudgetRollupRow
from chatticus.budget_rollup.runner import CE_STATUS_OK, CE_STATUS_PENDING
from chatticus.messaging.store import InMemoryMessagingStore
from chatticus.models import Organization, OrganizationStatus
from chatticus.organization_spend import (
    SPEND_CEILING_EXCEEDED_REASON,
    SPEND_CEILING_METER_UNAVAILABLE_REASON,
    month_to_date_combined_spend_usd,
    organization_computer_work_paused,
)

ENVIRONMENT = "development"
TENANT_ID = "acme"
NOW = datetime(2026, 8, 31, 12, 0, 0, tzinfo=UTC)


def _organization(*, ceiling: Decimal = Decimal("250.00")) -> Organization:
    return Organization(
        tenant_id=TENANT_ID,
        name="Acme Labs",
        status=OrganizationStatus.ENABLED,
        owner_user_id="owner",
        created_at=NOW,
        monthly_aws_spend_ceiling_usd=ceiling,
    )


def _put_row(
    store: InMemoryMessagingStore,
    *,
    rollup_date: date,
    combined_report_usd: Decimal | None,
    ce_status: str = CE_STATUS_OK,
) -> None:
    store.put_budget_rollup_row(
        BudgetRollupRow(
            tenant_id=TENANT_ID,
            environment=ENVIRONMENT,
            rollup_date=rollup_date,
            aws_cost_usd=combined_report_usd,
            vendor_cost_usd=Decimal("0"),
            combined_report_usd=combined_report_usd,
            ce_status=ce_status,
            alert_events=(),
            updated_at=NOW,
        )
    )


def test_missing_rollup_days_count_as_zero() -> None:
    store = InMemoryMessagingStore()
    _put_row(store, rollup_date=date(2026, 8, 31), combined_report_usd=Decimal("300"))
    meter = month_to_date_combined_spend_usd(
        store,
        TENANT_ID,
        ENVIRONMENT,
        date(2026, 8, 31),
    )
    assert meter.month_to_date_usd == Decimal("300")
    assert meter.meter_unknown is False


def test_pending_day_marks_meter_unknown() -> None:
    store = InMemoryMessagingStore()
    _put_row(
        store,
        rollup_date=date(2026, 8, 30),
        combined_report_usd=None,
        ce_status=CE_STATUS_PENDING,
    )
    _put_row(store, rollup_date=date(2026, 8, 31), combined_report_usd=Decimal("50"))
    meter = month_to_date_combined_spend_usd(
        store,
        TENANT_ID,
        ENVIRONMENT,
        date(2026, 8, 31),
    )
    assert meter.meter_unknown is True


def test_error_day_marks_meter_unknown() -> None:
    store = InMemoryMessagingStore()
    _put_row(
        store,
        rollup_date=date(2026, 8, 31),
        combined_report_usd=None,
        ce_status="error",
    )
    meter = month_to_date_combined_spend_usd(
        store,
        TENANT_ID,
        ENVIRONMENT,
        date(2026, 8, 31),
    )
    assert meter.meter_unknown is True


def test_ceiling_exceeded_when_mtd_meets_ceiling() -> None:
    store = InMemoryMessagingStore()
    _put_row(store, rollup_date=date(2026, 8, 31), combined_report_usd=Decimal("250"))
    paused, reason = organization_computer_work_paused(
        _organization(),
        store,
        ENVIRONMENT,
        date(2026, 8, 31),
    )
    assert paused is True
    assert reason == SPEND_CEILING_EXCEEDED_REASON


def test_meter_unknown_refuses_even_when_mtd_below_ceiling() -> None:
    store = InMemoryMessagingStore()
    _put_row(
        store,
        rollup_date=date(2026, 8, 31),
        combined_report_usd=None,
        ce_status=CE_STATUS_PENDING,
    )
    paused, reason = organization_computer_work_paused(
        _organization(),
        store,
        ENVIRONMENT,
        date(2026, 8, 31),
    )
    assert paused is True
    assert reason == SPEND_CEILING_METER_UNAVAILABLE_REASON
