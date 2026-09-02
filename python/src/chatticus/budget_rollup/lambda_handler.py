"""Lambda entrypoint for the scheduled daily budget rollup."""

from __future__ import annotations

import logging
import os
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

from chatticus.budget_alerts import SnsBudgetAlertsPublisher
from chatticus.budget_rollup.runner import run_daily_rollup
from chatticus.cost_explorer import Boto3CostExplorerReader
from chatticus.messaging.store import DynamoMessagingStore

logger = logging.getLogger("chatticus.budget_rollup")


def handler(_event: dict[str, Any], _context: object) -> None:
    """Run one daily rollup for the configured environment."""
    environment = os.environ["CHATTICUS_ENVIRONMENT"].strip()
    table_name = os.environ["CHATTICUS_MESSAGING_TABLE"].strip()
    monthly_limit_raw = os.environ.get(
        "CHATTICUS_BUDGETS_MONTHLY_LIMIT_USD", ""
    ).strip()
    topic_arn = os.environ.get("CHATTICUS_BUDGETS_ALERTS_TOPIC_ARN", "").strip()
    if not monthly_limit_raw:
        msg = "CHATTICUS_BUDGETS_MONTHLY_LIMIT_USD is required for daily rollup."
        raise RuntimeError(msg)
    monthly_limit_usd = Decimal(monthly_limit_raw)
    rollup_date = date.today() - timedelta(days=1)
    now = datetime.now(tz=UTC)
    import boto3

    store = DynamoMessagingStore(table_name)
    cost_explorer = Boto3CostExplorerReader(client=boto3.client("ce"))
    alerts = None
    if topic_arn:
        alerts = SnsBudgetAlertsPublisher(
            topic_arn=topic_arn,
            client=boto3.client("sns"),
        )
    logger.info(
        "daily_rollup_start environment=%s rollup_date=%s",
        environment,
        rollup_date.isoformat(),
    )
    run_daily_rollup(
        store=store,
        cost_explorer=cost_explorer,
        alerts=alerts,
        environment=environment,
        rollup_date=rollup_date,
        monthly_limit_usd=monthly_limit_usd,
        now=now,
    )
    logger.info(
        "daily_rollup_complete environment=%s rollup_date=%s",
        environment,
        rollup_date.isoformat(),
    )
