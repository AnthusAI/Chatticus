"""Cost Explorer reader for daily AWS spend attribution."""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal
from typing import Any, Protocol

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from chatticus.models import Organization

logger = logging.getLogger("chatticus.cost_explorer")

TENANT_TAG_KEY = "chatticus:tenant"


class CostExplorerReader(Protocol):
    """Read tenant-attributed AWS spend for one calendar day."""

    def daily_costs_by_tenant(
        self,
        *,
        environment: str,
        rollup_date: date,
    ) -> CostExplorerDayResult:
        """Return tenant AWS dollars for one environment and day."""


class AccountSpendUnreadableError(Exception):
    """A customer AWS account's spend could not be read."""


@dataclass(frozen=True)
class AccountDayResult:
    """One customer account's whole-account spend for one day."""

    pending: bool
    total_usd: Decimal | None


class AccountSpendReader(Protocol):
    """Read a customer's whole-account AWS spend through its own account."""

    def daily_total(
        self,
        *,
        organization: Organization,
        rollup_date: date,
    ) -> AccountDayResult:
        """Return the account's spend for one day, or raise when unreadable."""


class FakeAccountSpendReader:
    """In-memory customer-account spend for behave and unit tests."""

    def __init__(self) -> None:
        self._totals: dict[tuple[str, date], Decimal] = {}
        self._pending: set[tuple[str, date]] = set()
        self._unreadable: set[str] = set()

    def set_total(self, account_id: str, rollup_date: date, amount: Decimal) -> None:
        self._totals[(account_id, rollup_date)] = amount

    def set_day_pending(self, account_id: str, rollup_date: date) -> None:
        self._pending.add((account_id, rollup_date))

    def fail_account(self, account_id: str) -> None:
        self._unreadable.add(account_id)

    def daily_total(
        self,
        *,
        organization: Organization,
        rollup_date: date,
    ) -> AccountDayResult:
        account_id = organization.aws_account_id or ""
        if account_id in self._unreadable:
            raise AccountSpendUnreadableError(f"account {account_id} is unreadable")
        if (account_id, rollup_date) in self._pending:
            return AccountDayResult(pending=True, total_usd=None)
        amount = self._totals.get((account_id, rollup_date), Decimal("0"))
        return AccountDayResult(pending=False, total_usd=amount)


def account_day_from_response(response: Mapping[str, Any]) -> AccountDayResult:
    """Parse a whole-account daily Cost Explorer response."""
    results = response.get("ResultsByTime") or []
    if not results:
        return AccountDayResult(pending=True, total_usd=None)
    try:
        amount = Decimal(str(results[0]["Total"]["UnblendedCost"]["Amount"]))
    except (KeyError, TypeError, ArithmeticError) as error:
        raise AccountSpendUnreadableError(
            "Cost Explorer returned no total cost for the day"
        ) from error
    return AccountDayResult(pending=False, total_usd=amount)


@dataclass
class Boto3AccountSpendReader:
    """Assume the customer's role and read its whole-account daily spend."""

    sts_client: object

    def daily_total(
        self,
        *,
        organization: Organization,
        rollup_date: date,
    ) -> AccountDayResult:
        role_arn = organization.aws_cross_account_role
        if not role_arn:
            raise AccountSpendUnreadableError("no cross-account role is recorded")
        try:
            assumed = self.sts_client.assume_role(
                RoleArn=role_arn,
                RoleSessionName=f"chatticus-spend-{organization.tenant_id}"[:64],
                ExternalId=organization.aws_external_id or organization.tenant_id,
            )
            credentials = assumed["Credentials"]
            ce_client = boto3.client(
                "ce",
                region_name="us-east-1",
                aws_access_key_id=credentials["AccessKeyId"],
                aws_secret_access_key=credentials["SecretAccessKey"],
                aws_session_token=credentials["SessionToken"],
            )
            response = ce_client.get_cost_and_usage(
                TimePeriod={
                    "Start": rollup_date.isoformat(),
                    "End": (rollup_date + timedelta(days=1)).isoformat(),
                },
                Granularity="DAILY",
                Metrics=["UnblendedCost"],
            )
        except (BotoCoreError, ClientError, KeyError) as error:
            raise AccountSpendUnreadableError(
                f"{type(error).__name__}: {error}"
            ) from error
        return account_day_from_response(response)


@dataclass(frozen=True)
class CostExplorerDayResult:
    """One day's Cost Explorer response shape."""

    pending: bool
    costs_by_tenant: dict[str, Decimal]
    tenant_tag_active: bool = True


class FakeCostExplorerReader:
    """In-memory Cost Explorer for behave and unit tests."""

    def __init__(self) -> None:
        self._pending_days: set[tuple[str, date]] = set()
        self._costs: dict[tuple[str, str, date], Decimal] = {}
        self._tenant_tag_active = True

    def set_tenant_tag_active(self, active: bool) -> None:
        """Set whether the tenant cost allocation tag is active in Cost Explorer."""
        self._tenant_tag_active = active

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
        return CostExplorerDayResult(
            pending=False,
            costs_by_tenant=costs,
            tenant_tag_active=self._tenant_tag_active,
        )


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
                {"Type": "TAG", "Key": TENANT_TAG_KEY},
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
        tag_active = self._tenant_tag_active()
        groups = results[0].get("Groups") or []
        if not groups:
            return CostExplorerDayResult(
                pending=False, costs_by_tenant={}, tenant_tag_active=tag_active
            )
        costs: dict[str, Decimal] = {}
        for group in groups:
            keys = group.get("Keys") or []
            if not keys:
                continue
            tenant_key = keys[0]
            prefix = f"{TENANT_TAG_KEY}$"
            if not tenant_key.startswith(prefix):
                continue
            tenant_id = tenant_key[len(prefix) :]
            amount_raw = group["Metrics"]["UnblendedCost"]["Amount"]
            costs[tenant_id] = Decimal(amount_raw)
        return CostExplorerDayResult(
            pending=False, costs_by_tenant=costs, tenant_tag_active=tag_active
        )

    def _tenant_tag_active(self) -> bool:
        """Report whether Cost Explorer can group by the tenant tag at all.

        A tag that is not an active cost allocation tag never appears in
        results, so an absent tenant is unknowable rather than zero. A failed
        lookup counts as not active: the meter must not look fine unverified.
        """
        try:
            response = self.client.list_cost_allocation_tags(
                Status="Active", TagKeys=[TENANT_TAG_KEY]
            )
        except (BotoCoreError, ClientError) as error:
            logger.warning("tenant_tag_lookup_failed reason=%s", error)
            return False
        return bool(response.get("CostAllocationTags"))
