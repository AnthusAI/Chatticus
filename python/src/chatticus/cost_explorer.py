"""Cost Explorer reader for daily AWS spend attribution."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal
from typing import Protocol


class CostExplorerReader(Protocol):
    """Read tenant-attributed AWS spend for one calendar day."""

    def daily_costs_by_tenant(
        self,
        *,
        environment: str,
        rollup_date: date,
    ) -> CostExplorerDayResult:
        """Return tenant AWS dollars for one environment and day."""


@dataclass(frozen=True)
class CostExplorerDayResult:
    """One day's Cost Explorer response shape."""

    pending: bool
    costs_by_tenant: dict[str, Decimal]


class FakeCostExplorerReader:
    """In-memory Cost Explorer for behave and unit tests."""

    def __init__(self) -> None:
        self._pending_days: set[tuple[str, date]] = set()
        self._costs: dict[tuple[str, str, date], Decimal] = {}

    def set_day_pending(self, environment: str, rollup_date: date) -> None:
        """Mark one environment day as still populating in Cost Explorer."""
        self._pending_days.add((environment, rollup_date))

    def set_daily_cost(
        self,
        environment: str,
        tenant_id: str,
        rollup_date: date,
        amount: Decimal,
    ) -> None:
        """Return one tenant's attributed AWS spend on a day."""
        self._pending_days.discard((environment, rollup_date))
        self._costs[(environment, tenant_id, rollup_date)] = amount

    def mark_day_available(self, environment: str, rollup_date: date) -> None:
        """Mark one day as loaded in Cost Explorer with zero attributed spend."""
        self._pending_days.discard((environment, rollup_date))

    def daily_costs_by_tenant(
        self,
        *,
        environment: str,
        rollup_date: date,
    ) -> CostExplorerDayResult:
        if (environment, rollup_date) in self._pending_days:
            return CostExplorerDayResult(pending=True, costs_by_tenant={})
        costs = {
            tenant_id: amount
            for (env, tenant_id, day), amount in self._costs.items()
            if env == environment and day == rollup_date
        }
        return CostExplorerDayResult(pending=False, costs_by_tenant=costs)


@dataclass
class Boto3CostExplorerReader:
    """Live Cost Explorer reader for Lambda runs."""

    client: object

    def daily_costs_by_tenant(
        self,
        *,
        environment: str,
        rollup_date: date,
    ) -> CostExplorerDayResult:
        start = rollup_date.isoformat()
        end = (rollup_date + timedelta(days=1)).isoformat()
        response = self.client.get_cost_and_usage(
            TimePeriod={"Start": start, "End": end},
            Granularity="DAILY",
            Metrics=["UnblendedCost"],
            GroupBy=[
                {"Type": "TAG", "Key": "chatticus:tenant"},
            ],
            Filter={
                "Tags": {
                    "Key": "chatticus:environment",
                    "Values": [environment],
                }
            },
        )
        results = response.get("ResultsByTime") or []
        if not results:
            return CostExplorerDayResult(pending=True, costs_by_tenant={})
        groups = results[0].get("Groups") or []
        if not groups:
            return CostExplorerDayResult(pending=False, costs_by_tenant={})
        costs: dict[str, Decimal] = {}
        for group in groups:
            keys = group.get("Keys") or []
            if not keys:
                continue
            tenant_key = keys[0]
            prefix = "chatticus:tenant$"
            if not tenant_key.startswith(prefix):
                continue
            tenant_id = tenant_key[len(prefix) :]
            amount_raw = group["Metrics"]["UnblendedCost"]["Amount"]
            costs[tenant_id] = Decimal(amount_raw)
        return CostExplorerDayResult(pending=False, costs_by_tenant=costs)
