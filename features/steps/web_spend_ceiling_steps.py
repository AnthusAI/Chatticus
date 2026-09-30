"""Behave steps for raising the monthly AWS spend ceiling from the web SPA."""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal

from behave import given, then, when
from web_create_bot_steps import _harness_payload
from web_organization_signup_steps import _run_harness

from chatticus.budget_rollup.models import BudgetRollupRow
from chatticus.budget_rollup.runner import CE_STATUS_OK

SPEND_CEILING_FORM_TITLE = "Raise the monthly AWS spend ceiling"
SPEND_CEILING_MEMBER_GUIDANCE = (
    "An owner of this organization can raise the monthly AWS spend "
    "ceiling to resume computer work."
)


def _organization(context: object) -> object:
    return next(iter(context.orgs_by_name.values()))


def _visible_text(context: object) -> str:
    return context.membership_ui_harness.get("visibleText") or ""


@given(
    "the organization has a monthly spend ceiling of {ceiling:d} USD "
    "and month-to-date spend past it"
)
def given_ceiling_and_spend_past_it(context: object, ceiling: int) -> None:
    organization = _organization(context)
    plane = context.plane
    plane.set_monthly_aws_spend_ceiling(
        organization.tenant_id,
        context.current_identity.user_id,
        Decimal(ceiling),
    )
    rollup_date = plane.now().date()
    plane._messaging_store.put_budget_rollup_row(
        BudgetRollupRow(
            tenant_id=organization.tenant_id,
            environment=plane.budget_environment,
            rollup_date=rollup_date,
            aws_cost_usd=Decimal(ceiling) + Decimal(50),
            vendor_cost_usd=Decimal("0"),
            combined_report_usd=Decimal(ceiling) + Decimal(50),
            ce_status=CE_STATUS_OK,
            alert_events=(),
            updated_at=plane.now() - timedelta(hours=1),
        )
    )


@given('the web SPA shows "{name}" as paused for a member')
def given_web_spa_paused_for_member(context: object, name: str) -> None:
    _run_harness("reset", {"signup_mode": "invitation_only"})
    _run_harness("seed-session", {"email": "member@example.com", "id_token": "unused"})
    context.membership_ui_harness = _run_harness(
        "set-me-enabled",
        {
            "tenant_id": "acme",
            "name": name,
            "role": "member",
            "paused": "true",
        },
    )


@when("the web SPA reloads membership")
def when_web_spa_reloads_membership(context: object) -> None:
    context.membership_ui_harness = _run_harness(
        "refresh-me-from-api", _harness_payload(context)
    )


@when('the web SPA raises the spend ceiling to "{amount}"')
def when_web_spa_raises_spend_ceiling(context: object, amount: str) -> None:
    _run_harness("refresh-me-from-api", _harness_payload(context))
    payload = _harness_payload(context)
    payload["amount"] = amount
    context.membership_ui_harness = _run_harness("submit-spend-ceiling", payload)


@then("the web SPA offers to raise the spend ceiling")
def then_web_spa_offers_raise(context: object) -> None:
    assert SPEND_CEILING_FORM_TITLE in _visible_text(
        context
    ), context.membership_ui_harness


@then("the web SPA does not offer to raise the spend ceiling")
def then_web_spa_does_not_offer_raise(context: object) -> None:
    assert SPEND_CEILING_FORM_TITLE not in _visible_text(
        context
    ), context.membership_ui_harness


@then("the web SPA tells the member to ask an owner")
def then_web_spa_tells_member_to_ask_owner(context: object) -> None:
    assert SPEND_CEILING_MEMBER_GUIDANCE in _visible_text(
        context
    ), context.membership_ui_harness


@then("the web SPA confirms the spend ceiling is now {amount:d}")
def then_web_spa_confirms_ceiling(context: object, amount: int) -> None:
    expected = f"Monthly AWS spend ceiling is now ${amount}."
    harness = context.membership_ui_harness
    assert harness.get("spendCeilingError") is None, harness
    assert harness.get("spendCeilingConfirmation") == expected, harness
    assert expected in _visible_text(context), harness


@then("the web SPA blocks the ceiling change before sending it")
def then_web_spa_blocks_ceiling_change(context: object) -> None:
    harness = context.membership_ui_harness
    assert harness.get("spendCeilingBlocked") is True, harness
    assert harness.get("spendCeilingConfirmation") is None, harness


@then("the organization ceiling is {amount:d} USD")
def then_organization_ceiling_is(context: object, amount: int) -> None:
    organization = context.plane.get_organization(_organization(context).tenant_id)
    assert organization.monthly_aws_spend_ceiling_usd == Decimal(
        amount
    ), organization.monthly_aws_spend_ceiling_usd


@then("the web SPA no longer shows computer work as paused")
def then_web_spa_no_longer_paused(context: object) -> None:
    harness = context.membership_ui_harness
    organizations = harness["me"]["organizations"]
    assert organizations[0].get("computer_work_paused") is False, organizations
    assert SPEND_CEILING_FORM_TITLE not in _visible_text(context), harness
