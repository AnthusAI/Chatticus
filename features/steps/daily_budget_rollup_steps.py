"""Behave steps for the daily budget rollup."""

from __future__ import annotations

import json
from datetime import UTC, date, datetime
from decimal import Decimal

from behave import given, then, when
from organization_steps import _plane

from chatticus.budget_alerts import FakeBudgetAlertsPublisher
from chatticus.budget_rollup.alert_recorder import record_budget_alert_from_sns
from chatticus.budget_rollup.runner import ROLLUP_ALERT_SOURCE, run_daily_rollup
from chatticus.control_plane import ControlPlane
from chatticus.cost_explorer import FakeCostExplorerReader
from chatticus.messaging.store import InMemoryMessagingStore
from chatticus.vendor_ledger import (
    BILLED_VIA_AWS,
    BILLED_VIA_VENDOR,
    VendorLedgerRow,
)


def _rollup_harness(context: object) -> None:
    context.messaging_store = InMemoryMessagingStore()
    context.plane = ControlPlane(messaging_store=context.messaging_store)
    context.orgs_by_name = {}
    context.identities_by_email = getattr(context, "identities_by_email", {})
    context.current_identity = getattr(context, "current_identity", None)
    context.last_invitation = getattr(context, "last_invitation", None)
    context.last_error = getattr(context, "last_error", None)
    context.now = datetime(2026, 8, 31, 6, 0, 0, tzinfo=UTC)
    context.budget_environment = "development"
    context.monthly_limit_usd = Decimal("100")
    context.cost_explorer = FakeCostExplorerReader()
    context.budget_alerts = FakeBudgetAlertsPublisher()
    context.vendor_spend_by_tenant_day: dict[tuple[str, str], Decimal] = {}


@given('a daily budget rollup harness for environment "{environment}"')
def given_rollup_harness(context: object, environment: str) -> None:
    _rollup_harness(context)
    context.budget_environment = environment


@given("the account monthly budget limit is {amount} USD")
def given_monthly_limit(context: object, amount: str) -> None:
    context.monthly_limit_usd = Decimal(amount)


@given('organization "{name}" with tenant "{tenant_id}" is enabled')
def given_enabled_org(context: object, name: str, tenant_id: str) -> None:
    plane = _plane(context)
    org = plane.admin_seed_organization(
        tenant_id,
        "owner@example.com",
        name=name,
        now=context.now,
    )
    context.orgs_by_name[name] = org


@given('Cost Explorer reports {amount} USD for tenant "{tenant_id}" on {day}')
def given_ce_tenant_cost(
    context: object, amount: str, tenant_id: str, day: str
) -> None:
    context.cost_explorer.set_daily_cost(
        context.budget_environment,
        tenant_id,
        date.fromisoformat(day),
        Decimal(amount),
    )


@given("Cost Explorer has no data for {day}")
def given_ce_no_data(context: object, day: str) -> None:
    context.cost_explorer.set_day_pending(
        context.budget_environment,
        date.fromisoformat(day),
    )


@given("Cost Explorer returns zero attributed AWS spend on {day}")
def given_ce_zero_attributed(context: object, day: str) -> None:
    context.cost_explorer.mark_day_available(
        context.budget_environment,
        date.fromisoformat(day),
    )


@given('vendor spend for tenant "{tenant_id}" on {day} totals {amount} USD')
@when('vendor spend for tenant "{tenant_id}" on {day} totals {amount} USD')
def given_vendor_spend_total(
    context: object, tenant_id: str, day: str, amount: str
) -> None:
    _clear_vendor_spend_for_day(context, tenant_id, day)
    _record_vendor_spend(
        context,
        tenant_id=tenant_id,
        day=day,
        amount=Decimal(amount),
        billed_via=BILLED_VIA_VENDOR,
    )


@given(
    'vendor spend for tenant "{tenant_id}" on {day} includes '
    "{amount} USD billed_via vendor"
)
def given_vendor_billed_spend(
    context: object, tenant_id: str, day: str, amount: str
) -> None:
    _record_vendor_spend(
        context,
        tenant_id=tenant_id,
        day=day,
        amount=Decimal(amount),
        billed_via=BILLED_VIA_VENDOR,
    )


@given(
    'vendor spend for tenant "{tenant_id}" on {day} includes '
    "aws-billed tokens with null dollars"
)
def given_aws_billed_spend(context: object, tenant_id: str, day: str) -> None:
    _record_vendor_spend(
        context,
        tenant_id=tenant_id,
        day=day,
        amount=Decimal("0"),
        billed_via=BILLED_VIA_AWS,
        turn_suffix="-aws",
    )


@when("the daily budget rollup runs for {day}")
@when("the daily budget rollup runs for {day} again")
def when_daily_rollup_runs(context: object, day: str) -> None:
    rollup_date = date.fromisoformat(day)
    run_daily_rollup(
        store=context.messaging_store,
        cost_explorer=context.cost_explorer,
        alerts=context.budget_alerts,
        environment=context.budget_environment,
        rollup_date=rollup_date,
        monthly_limit_usd=context.monthly_limit_usd,
        now=context.now,
    )


@when('an AWS Budgets alert arrives for budget "{budget_name}" on {day}')
def when_aws_budget_alert(context: object, budget_name: str, day: str) -> None:
    payload = {
        "budgetName": budget_name,
        "budgetType": "COST",
        "budgetThreshold": "80",
        "notificationType": "ACTUAL",
    }
    _record_aws_budget_alert(context, day, payload)


@when('a PascalCase AWS Budgets alert arrives for budget "{budget_name}" on {day}')
def when_pascal_case_aws_budget_alert(
    context: object, budget_name: str, day: str
) -> None:
    payload = {
        "BudgetName": budget_name,
        "BudgetType": "COST",
        "BudgetThreshold": "80",
        "NotificationType": "ACTUAL",
        "AccountId": "111111111111",
    }
    _record_aws_budget_alert(context, day, payload)


def _record_aws_budget_alert(
    context: object, day: str, payload: dict[str, object]
) -> None:
    record_budget_alert_from_sns(
        store=context.messaging_store,
        environment=context.budget_environment,
        rollup_date=date.fromisoformat(day),
        sns_message=json.dumps(payload),
        now=context.now,
    )


@when("a rollup threshold alert message arrives on the budgets topic")
def when_rollup_alert_on_topic(context: object) -> None:
    payload = {
        "source": ROLLUP_ALERT_SOURCE,
        "kind": "vendor_threshold",
        "threshold_percent": 50,
    }
    record_budget_alert_from_sns(
        store=context.messaging_store,
        environment=context.budget_environment,
        rollup_date=date(2026, 8, 31),
        sns_message=json.dumps(payload),
        now=context.now,
    )


@then(
    'the budget rollup for tenant "{tenant_id}" environment "{environment}" '
    "on {day} has aws_cost_usd {amount}"
)
def then_rollup_aws_cost(
    context: object, tenant_id: str, environment: str, day: str, amount: str
) -> None:
    row = _rollup_row(context, tenant_id, environment, day)
    assert row.aws_cost_usd == Decimal(amount)


@then(
    'the budget rollup for tenant "{tenant_id}" environment "{environment}" '
    "on {day} has vendor_cost_usd {amount}"
)
def then_rollup_vendor_cost(
    context: object, tenant_id: str, environment: str, day: str, amount: str
) -> None:
    row = _rollup_row(context, tenant_id, environment, day)
    assert row.vendor_cost_usd == Decimal(amount)


@then(
    'the budget rollup for tenant "{tenant_id}" environment "{environment}" '
    "on {day} has combined_report_usd {amount}"
)
def then_rollup_combined(
    context: object, tenant_id: str, environment: str, day: str, amount: str
) -> None:
    row = _rollup_row(context, tenant_id, environment, day)
    assert row.combined_report_usd == Decimal(amount)


@then(
    'the budget rollup for tenant "{tenant_id}" environment "{environment}" '
    "on {day} has null aws_cost_usd"
)
def then_rollup_null_aws(
    context: object, tenant_id: str, environment: str, day: str
) -> None:
    row = _rollup_row(context, tenant_id, environment, day)
    assert row.aws_cost_usd is None


@then(
    'the budget rollup for tenant "{tenant_id}" environment "{environment}" '
    "on {day} has null combined_report_usd"
)
def then_rollup_null_combined(
    context: object, tenant_id: str, environment: str, day: str
) -> None:
    row = _rollup_row(context, tenant_id, environment, day)
    assert row.combined_report_usd is None


@then(
    'the budget rollup for tenant "{tenant_id}" environment "{environment}" '
    'on {day} has ce_status "{status}"'
)
def then_rollup_ce_status(
    context: object, tenant_id: str, environment: str, day: str, status: str
) -> None:
    row = _rollup_row(context, tenant_id, environment, day)
    assert row.ce_status == status


@then("exactly {count:d} budget threshold alert was published")
@then("exactly {count:d} budget threshold alerts were published")
def then_threshold_alert_count(context: object, count: int) -> None:
    assert len(context.budget_alerts.published) == count


@then("no budget threshold alert was published")
def then_no_threshold_alert(context: object) -> None:
    assert len(context.budget_alerts.published) == 0


@then("the budget threshold alert has threshold_percent {percent:d}")
def then_threshold_percent(context: object, percent: int) -> None:
    assert context.budget_alerts.published
    payload = context.budget_alerts.published[-1]
    assert payload["threshold_percent"] == percent


@then('the budget threshold alert source is "{source}"')
def then_threshold_source(context: object, source: str) -> None:
    assert context.budget_alerts.published
    payload = context.budget_alerts.published[-1]
    assert payload["source"] == source


@then("the account budget rollup for {day} records an aws_budget_alert")
def then_account_aws_budget_alert(context: object, day: str) -> None:
    row = context.messaging_store.get_account_budget_rollup_row(
        context.budget_environment,
        date.fromisoformat(day),
    )
    assert row is not None
    assert any(event.source == "aws_budget" for event in row.alert_events)


@then("the account budget rollup for {day} still has {count:d} aws_budget_alert")
def then_account_aws_budget_alert_count(context: object, day: str, count: int) -> None:
    row = context.messaging_store.get_account_budget_rollup_row(
        context.budget_environment,
        date.fromisoformat(day),
    )
    assert row is not None
    aws_events = [event for event in row.alert_events if event.source == "aws_budget"]
    assert len(aws_events) == count


@then(
    "there is {count:d} budget rollup row for tenant "
    '"{tenant_id}" environment "{environment}" on {day}'
)
def then_rollup_row_count(
    context: object, count: int, tenant_id: str, environment: str, day: str
) -> None:
    rows = context.messaging_store.list_budget_rollup_rows_for_day(
        tenant_id,
        environment,
        date.fromisoformat(day),
    )
    assert len(rows) == count


def _rollup_row(context: object, tenant_id: str, environment: str, day: str) -> object:
    row = context.messaging_store.get_budget_rollup_row(
        tenant_id,
        environment,
        date.fromisoformat(day),
    )
    assert row is not None, f"No rollup row for {tenant_id!r} {environment!r} on {day}."
    return row


def _clear_vendor_spend_for_day(context: object, tenant_id: str, day: str) -> None:
    target_day = date.fromisoformat(day)
    remaining = [
        row
        for row in context.messaging_store.list_vendor_ledger_rows_for_tenant(tenant_id)
        if row.recorded_at.date() != target_day
    ]
    context.messaging_store._vendor_ledger = {
        (row.tenant_id, row.turn_id): row for row in remaining
    }


def _record_vendor_spend(
    context: object,
    *,
    tenant_id: str,
    day: str,
    amount: Decimal,
    billed_via: str,
    turn_suffix: str = "",
) -> None:
    from chatticus.vendor_ledger import CompletionUsage, record_vendor_spend
    from chatticus.vendor_prices import VendorPrice, register_vendor_price

    recorded_at = datetime.fromisoformat(f"{day}T12:00:00+00:00")
    turn_id = f"{tenant_id}-{day}-{billed_via}{turn_suffix}"
    if billed_via == BILLED_VIA_VENDOR and amount == Decimal("0.00004"):
        register_vendor_price(
            "openai",
            "chatticus-test-model",
            VendorPrice(Decimal("2.00"), Decimal("4.00")),
        )
        record_vendor_spend(
            context.messaging_store,
            tenant_id,
            turn_id,
            CompletionUsage(
                vendor="openai",
                model="chatticus-test-model",
                input_tokens=10,
                output_tokens=5,
            ),
            billed_via=billed_via,
            now=recorded_at,
        )
        return
    row = VendorLedgerRow(
        tenant_id=tenant_id,
        turn_id=turn_id,
        vendor="openai",
        model="chatticus-test-model",
        input_tokens=10,
        output_tokens=5,
        billed_via=billed_via,
        input_price_per_million_usd=(
            Decimal("2.00") if billed_via == BILLED_VIA_VENDOR else None
        ),
        output_price_per_million_usd=(
            Decimal("4.00") if billed_via == BILLED_VIA_VENDOR else None
        ),
        cost_usd=amount if billed_via == BILLED_VIA_VENDOR else None,
        recorded_at=recorded_at,
    )
    context.messaging_store.insert_vendor_ledger_row(row)
