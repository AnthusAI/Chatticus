"""Month-to-date organization spend against the provisioning ceiling."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal

from chatticus.budget_rollup.runner import CE_STATUS_OK, CE_STATUS_PENDING
from chatticus.messaging.store import MessagingStore
from chatticus.models import Organization

MTD_UNKNOWN_CE_STATUSES = frozenset({CE_STATUS_PENDING, "error"})

SPEND_CEILING_EXCEEDED_REASON = "monthly AWS spend ceiling exceeded"
SPEND_CEILING_METER_UNAVAILABLE_REASON = (
    "monthly AWS spend is unavailable until Cost Explorer catches up"
)


@dataclass(frozen=True)
class OrganizationSpendMeter:
    """Month-to-date combined spend and whether the meter is incomplete."""

    month_to_date_usd: Decimal
    meter_unknown: bool


def month_to_date_combined_spend_usd(
    store: MessagingStore,
    tenant_id: str,
    environment: str,
    as_of: date,
) -> OrganizationSpendMeter:
    """Sum ok rollup rows from month start through ``as_of``.

    Days with no rollup row count as zero. Any day with ``pending`` or
    ``error`` ce_status marks the meter unknown for fail-closed enforcement.
    """
    month_start = as_of.replace(day=1)
    total = Decimal("0")
    meter_unknown = False
    current = month_start
    while current <= as_of:
        row = store.get_budget_rollup_row(tenant_id, environment, current)
        if row is not None:
            if row.ce_status in MTD_UNKNOWN_CE_STATUSES:
                meter_unknown = True
            elif row.ce_status == CE_STATUS_OK:
                if row.combined_report_usd is None:
                    meter_unknown = True
                else:
                    total += row.combined_report_usd
            else:
                meter_unknown = True
        current += timedelta(days=1)
    return OrganizationSpendMeter(month_to_date_usd=total, meter_unknown=meter_unknown)


def organization_computer_work_paused(
    organization: Organization,
    store: MessagingStore,
    environment: str,
    as_of: date,
) -> tuple[bool, str | None]:
    """Return whether new computer work should be refused for spend reasons."""
    ceiling = organization.monthly_aws_spend_ceiling_usd
    if ceiling is None:
        return False, None
    meter = month_to_date_combined_spend_usd(
        store,
        organization.tenant_id,
        environment,
        as_of,
    )
    if meter.meter_unknown:
        return True, SPEND_CEILING_METER_UNAVAILABLE_REASON
    if meter.month_to_date_usd >= ceiling:
        return True, SPEND_CEILING_EXCEEDED_REASON
    return False, None
