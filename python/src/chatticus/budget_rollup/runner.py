"""Daily budget rollup combining AWS Cost Explorer and vendor ledger meters."""

from __future__ import annotations

import logging
from datetime import date, datetime
from decimal import Decimal

from chatticus.budget_alerts import BudgetAlertsPublisher
from chatticus.budget_rollup.models import (
    BudgetRollupRow,
    BudgetThresholdState,
)
from chatticus.cost_explorer import (
    AccountSpendReader,
    AccountSpendUnreadableError,
    CostExplorerDayResult,
    CostExplorerReader,
)
from chatticus.messaging.store import MessagingStore
from chatticus.models import Organization, OrganizationStatus
from chatticus.vendor_ledger import BILLED_VIA_VENDOR

ROLLUP_ALERT_SOURCE = "chatticus.daily_rollup"
DEFAULT_THRESHOLD_BANDS = (50, 80, 100)
CE_STATUS_OK = "ok"
CE_STATUS_PENDING = "pending"
CE_STATUS_ERROR = "error"

logger = logging.getLogger("chatticus.budget_rollup")


def run_daily_rollup(
    *,
    store: MessagingStore,
    cost_explorer: CostExplorerReader,
    account_spend: AccountSpendReader | None = None,
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
        aws_cost_usd, ce_status = _aws_spend_for(
            organization, ce_result, account_spend, rollup_date
        )
        combined_report_usd = (
            aws_cost_usd + vendor_cost_usd if aws_cost_usd is not None else None
        )
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


def _aws_spend_for(
    organization: Organization,
    ce_result: CostExplorerDayResult,
    account_spend: AccountSpendReader | None,
    rollup_date: date,
) -> tuple[Decimal | None, str]:
    """Return one organization's AWS dollars and the meter status for the day.

    An organization in its own AWS account is read through that account. A
    read that fails is ``error``, never zero: an unreadable meter must not look
    like an organization that spent nothing.
    """
    if organization.aws_cross_account_role:
        if account_spend is None:
            return None, CE_STATUS_ERROR
        try:
            day = account_spend.daily_total(
                organization=organization, rollup_date=rollup_date
            )
        except AccountSpendUnreadableError as error:
            logger.warning(
                "account_spend_unreadable tenant_id=%s reason=%s",
                organization.tenant_id,
                error,
            )
            return None, CE_STATUS_ERROR
        if day.pending or day.total_usd is None:
            return None, CE_STATUS_PENDING
        return day.total_usd, CE_STATUS_OK
    if ce_result.pending:
        return None, CE_STATUS_PENDING
    return ce_result.costs_by_tenant.get(organization.tenant_id, Decimal("0")), (
        CE_STATUS_OK
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
