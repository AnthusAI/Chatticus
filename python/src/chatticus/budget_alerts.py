"""Budget alert publishing for daily rollup threshold crossings."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Protocol


class BudgetAlertsPublisher(Protocol):
    """Publish rollup threshold alerts to the budgets SNS topic."""

    def publish_threshold_crossing(
        self,
        *,
        environment: str,
        threshold_percent: int,
        vendor_mtd_usd: Decimal,
        monthly_limit_usd: Decimal,
        rollup_date: str,
    ) -> None:
        """Publish one vendor-meter threshold alert."""


@dataclass
class FakeBudgetAlertsPublisher:
    """Record published alerts for behave and unit tests."""

    published: list[dict[str, Any]] = field(default_factory=list)

    def publish_threshold_crossing(
        self,
        *,
        environment: str,
        threshold_percent: int,
        vendor_mtd_usd: Decimal,
        monthly_limit_usd: Decimal,
        rollup_date: str,
    ) -> None:
        self.published.append(
            {
                "source": "chatticus.daily_rollup",
                "kind": "vendor_threshold",
                "environment": environment,
                "threshold_percent": threshold_percent,
                "vendor_mtd_usd": format(vendor_mtd_usd, "f"),
                "monthly_limit_usd": format(monthly_limit_usd, "f"),
                "rollup_date": rollup_date,
            }
        )


@dataclass
class SnsBudgetAlertsPublisher:
    """Publish rollup alerts through SNS."""

    topic_arn: str
    client: object

    def publish_threshold_crossing(
        self,
        *,
        environment: str,
        threshold_percent: int,
        vendor_mtd_usd: Decimal,
        monthly_limit_usd: Decimal,
        rollup_date: str,
    ) -> None:
        payload = {
            "source": "chatticus.daily_rollup",
            "kind": "vendor_threshold",
            "environment": environment,
            "threshold_percent": threshold_percent,
            "vendor_mtd_usd": format(vendor_mtd_usd, "f"),
            "monthly_limit_usd": format(monthly_limit_usd, "f"),
            "rollup_date": rollup_date,
        }
        self.client.publish(
            TopicArn=self.topic_arn,
            Message=json.dumps(payload),
            Subject=(
                f"Chatticus vendor spend reached {threshold_percent}% "
                f"of monthly limit ({environment})"
            ),
        )
