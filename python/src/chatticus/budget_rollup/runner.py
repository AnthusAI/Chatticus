"""Daily budget rollup combining AWS Cost Explorer and vendor ledger meters."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from chatticus.budget_alerts import BudgetAlertsPublisher
from chatticus.budget_rollup.models import (
    BudgetRollupRow,
    BudgetThresholdState,
)
from chatticus.cost_explorer import CostExplorerReader
from chatticus.messaging.store import MessagingStore
from chatticus.models import OrganizationStatus
from chatticus.vendor_ledger import BILLED_VIA_VENDOR

ROLLUP_ALERT_SOURCE = "chatticus.daily_rollup"
DEFAULT_THRESHOLD_BANDS = (50, 80, 100)
CE_STATUS_OK = "ok"
CE_STATUS_PENDING = "pending"


def run_daily_rollup(
    *,
    store: MessagingStore,
    cost_explorer: CostExplorerReader,
    alerts: BudgetAlertsPublisher | None,
    environment: str,
    rollup_date: date,
    monthly_limit_usd: Decimal,
    now: datetime,
    threshold_bands: tuple[int, ...] = DEFAULT_THRESHOLD_BANDS,
) -> None:
    """Write org-environment-day rows and publish vendor threshold alerts once."""
    ce_result = cost_explorer.daily_costs_by_tenant(
        environment=environment,
        rollup_date=rollup_date,
    )
    organizations = store.list_organizations_by_status(OrganizationStatus.ENABLED)
    for organization in organizations:
        tenant_id = organization.tenant_id
        vendor_cost_usd = _vendor_daily_total(store, tenant_id, rollup_date)
        if ce_result.pending:
            aws_cost_usd: Decimal | None = None
            ce_status = CE_STATUS_PENDING
            combined_report_usd: Decimal | None = None
        else:
            aws_cost_usd = ce_result.costs_by_tenant.get(tenant_id, Decimal("0"))
            ce_status = CE_STATUS_OK
            combined_report_usd = aws_cost_usd + vendor_cost_usd
        existing = store.get_budget_rollup_row(tenant_id, environment, rollup_date)
        alert_events = existing.alert_events if existing is not None else ()
        store.put_budget_rollup_row(
            BudgetRollupRow(
                tenant_id=tenant_id,
                environment=environment,
                rollup_date=rollup_date,
                aws_cost_usd=aws_cost_usd,
                vendor_cost_usd=vendor_cost_usd,
                combined_report_usd=combined_report_usd,
                ce_status=ce_status,
                alert_events=alert_events,
                updated_at=now,
            )
        )
    _maybe_publish_vendor_threshold(
        store=store,
        alerts=alerts,
        environment=environment,
        rollup_date=rollup_date,
        monthly_limit_usd=monthly_limit_usd,
        threshold_bands=threshold_bands,
        now=now,
    )


def _vendor_daily_total(
    store: MessagingStore, tenant_id: str, rollup_date: date
) -> Decimal:
    total = Decimal("0")
    for row in store.list_vendor_ledger_rows_for_tenant(tenant_id):
        if row.recorded_at.date() != rollup_date:
            continue
        if row.billed_via != BILLED_VIA_VENDOR:
            continue
        if row.cost_usd is None:
            continue
        total += row.cost_usd
    return total


def _vendor_mtd_total(store: MessagingStore, rollup_date: date) -> Decimal:
    month_start = rollup_date.replace(day=1)
    total = Decimal("0")
    for organization in store.list_organizations_by_status(OrganizationStatus.ENABLED):
        for row in store.list_vendor_ledger_rows_for_tenant(organization.tenant_id):
            row_day = row.recorded_at.date()
            if row_day < month_start or row_day > rollup_date:
                continue
            if row.billed_via != BILLED_VIA_VENDOR:
                continue
            if row.cost_usd is None:
                continue
            total += row.cost_usd
    return total


def _maybe_publish_vendor_threshold(
    *,
    store: MessagingStore,
    alerts: BudgetAlertsPublisher | None,
    environment: str,
    rollup_date: date,
    monthly_limit_usd: Decimal,
    threshold_bands: tuple[int, ...],
    now: datetime,
) -> None:
    if alerts is None or monthly_limit_usd <= 0:
        return
    vendor_mtd = _vendor_mtd_total(store, rollup_date)
    crossed_band = _highest_band_crossed(vendor_mtd, monthly_limit_usd, threshold_bands)
    if crossed_band is None:
        return
    state = store.get_budget_threshold_state(environment)
    last_band = state.last_notified_band if state is not None else 0
    if crossed_band <= last_band:
        return
    alerts.publish_threshold_crossing(
        environment=environment,
        threshold_percent=crossed_band,
        vendor_mtd_usd=vendor_mtd,
        monthly_limit_usd=monthly_limit_usd,
        rollup_date=rollup_date.isoformat(),
    )
    store.put_budget_threshold_state(
        BudgetThresholdState(
            environment=environment,
            last_notified_band=crossed_band,
            updated_at=now,
        )
    )


def _highest_band_crossed(
    spend: Decimal,
    monthly_limit_usd: Decimal,
    threshold_bands: tuple[int, ...],
) -> int | None:
    crossed: int | None = None
    for band in sorted(threshold_bands):
        threshold_amount = (
            monthly_limit_usd * Decimal(band) / Decimal("100")
        ).quantize(Decimal("0.00000001"))
        if spend >= threshold_amount:
            crossed = band
    return crossed
