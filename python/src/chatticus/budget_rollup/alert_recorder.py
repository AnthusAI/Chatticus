"""Record AWS Budgets SNS alerts on durable account rollup rows."""

from __future__ import annotations

import json
import logging
from datetime import UTC, date, datetime
from decimal import Decimal

from chatticus.budget_rollup.models import (
    ACCOUNT_TENANT_ID,
    BudgetAlertEvent,
    BudgetRollupRow,
)
from chatticus.budget_rollup.runner import CE_STATUS_OK, ROLLUP_ALERT_SOURCE
from chatticus.messaging.store import DynamoMessagingStore, MessagingStore

logger = logging.getLogger("chatticus.budget_rollup.alert_recorder")


def handler(event: dict[str, object], _context: object) -> None:
    """Append AWS Budgets alerts from SNS to the account rollup row."""
    import os

    table_name = os.environ["CHATTICUS_MESSAGING_TABLE"].strip()
    environment = os.environ["CHATTICUS_ENVIRONMENT"].strip()
    store = DynamoMessagingStore(table_name)
    for record in event.get("Records", []):
        sns_message = record.get("Sns", {}).get("Message")
        if not isinstance(sns_message, str):
            continue
        rollup_date = date.today()
        record_budget_alert_from_sns(
            store=store,
            environment=environment,
            rollup_date=rollup_date,
            sns_message=sns_message,
            now=datetime.now(tz=UTC),
        )


def record_budget_alert_from_sns(
    *,
    store: MessagingStore,
    environment: str,
    rollup_date: date,
    sns_message: str,
    now: datetime,
) -> bool:
    """Parse one SNS payload and record AWS Budgets alerts only."""
    payload = _parse_sns_payload(sns_message)
    if payload is None:
        return False
    if payload.get("source") == ROLLUP_ALERT_SOURCE:
        return False
    budget_name = _budget_name_from_payload(payload)
    if budget_name is None:
        return False
    detail = json.dumps(payload, sort_keys=True)
    existing = store.get_account_budget_rollup_row(environment, rollup_date)
    alert_events = list(existing.alert_events if existing is not None else ())
    alert_events.append(
        BudgetAlertEvent(source="aws_budget", fired_at=now, detail=detail)
    )
    store.put_account_budget_rollup_row(
        BudgetRollupRow(
            tenant_id=ACCOUNT_TENANT_ID,
            environment=environment,
            rollup_date=rollup_date,
            aws_cost_usd=existing.aws_cost_usd if existing is not None else None,
            vendor_cost_usd=(
                existing.vendor_cost_usd if existing is not None else Decimal("0")
            ),
            combined_report_usd=(
                existing.combined_report_usd if existing is not None else None
            ),
            ce_status=existing.ce_status if existing is not None else CE_STATUS_OK,
            alert_events=tuple(alert_events),
            updated_at=now,
        )
    )
    logger.info(
        "aws_budget_alert_recorded budget_name=%s environment=%s rollup_date=%s",
        budget_name,
        environment,
        rollup_date.isoformat(),
    )
    return True


def _budget_name_from_payload(payload: dict[str, object]) -> str | None:
    for key in ("BudgetName", "budgetName"):
        value = payload.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _parse_sns_payload(message: str) -> dict[str, object] | None:
    try:
        payload = json.loads(message)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    return payload
