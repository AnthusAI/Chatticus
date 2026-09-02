"""Behave steps for delegated authority ceilings, delegations, and escalation."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from behave import given, then, when
from behave.exception import StepNotImplementedError

NOW = datetime(2026, 8, 31, 12, 0, 0, tzinfo=UTC)


def _table_args(context: object) -> dict[str, str]:
    table = context.table
    values = {table.headings[0].strip(): table.headings[1].strip()}
    for row in table:
        values[row.cells[0].strip()] = row.cells[1].strip()
    return values


def _org(context: object, name: str) -> object:
    org = getattr(context, "orgs_by_name", {}).get(name)
    if org is None:
        raise AssertionError(f"Unknown organization {name!r}.")
    return org


def _member_ceilings(context: object) -> dict[tuple[str, str, str], dict[str, str]]:
    ceilings = getattr(context, "member_authority_ceilings", None)
    if ceilings is None:
        ceilings = {}
        context.member_authority_ceilings = ceilings
    return ceilings


def _delegations(context: object) -> list[dict[str, object]]:
    delegations = getattr(context, "member_delegations", None)
    if delegations is None:
        delegations = []
        context.member_delegations = delegations
    return delegations


def _pending_behavior(step_name: str) -> None:
    raise StepNotImplementedError(
        f"Delegated authority behavior is not implemented yet: {step_name}"
    )


@given(
    'organization "{org_name}" member "{email}" has authority ceiling for '
    'structured "{action_type}" with:'
)
def given_member_authority_ceiling(
    context: object, org_name: str, email: str, action_type: str
) -> None:
    org = _org(context, org_name)
    context.plane.set_member_authority_ceiling(
        org.tenant_id,
        email,
        action_type,
        arguments=_table_args(context),
    )


@given(
    '"{delegator}" delegates approval authority to "{delegate}" until {days:d} days '
    'from now covering structured "{action_type}" with:'
)
def given_covering_delegation(
    context: object,
    delegator: str,
    delegate: str,
    days: int,
    action_type: str,
) -> None:
    org = next(iter(context.orgs_by_name.values()))
    _delegations(context).append(
        {
            "tenant_id": org.tenant_id,
            "delegator": delegator,
            "delegate": delegate,
            "action_type": action_type,
            "arguments": _table_args(context),
            "expires_at": NOW + timedelta(days=days),
        }
    )


@when('"{email}" approves that consequential operation within their ceiling')
def when_member_approves_within_ceiling(context: object, email: str) -> None:
    context.delegated_authority_actor = email
    _pending_behavior("member approves within authority ceiling")


@when('"{email}" tries to approve that consequential operation within their ceiling')
def when_member_tries_approve_within_ceiling(context: object, email: str) -> None:
    context.delegated_authority_actor = email
    _pending_behavior("member refused outside authority ceiling")


@when('"{email}" writes an always-allow rule for structured "{action_type}" with:')
def when_member_writes_always_allow(
    context: object, email: str, action_type: str
) -> None:
    context.delegated_authority_actor = email
    context.delegated_authority_action_type = action_type
    context.delegated_authority_rule_arguments = _table_args(context)
    _pending_behavior("member writes always-allow within standing")


@when(
    '"{email}" tries to write an always-allow rule for structured "{action_type}" with:'
)
def when_member_tries_write_always_allow(
    context: object, email: str, action_type: str
) -> None:
    context.delegated_authority_actor = email
    context.delegated_authority_action_type = action_type
    context.delegated_authority_rule_arguments = _table_args(context)
    _pending_behavior("member refused always-allow broader than standing")


@when('"{email}" approves that consequential operation as delegate')
def when_delegate_approves(context: object, email: str) -> None:
    context.delegated_authority_actor = email
    _pending_behavior("delegate approves while delegation is active")


@when('"{email}" tries to approve that consequential operation as delegate')
def when_delegate_tries_approve(context: object, email: str) -> None:
    context.delegated_authority_actor = email
    _pending_behavior("delegate refused after delegation expired")


@when("{days:d} days pass")
def when_days_pass(context: object, days: int) -> None:
    context.plane.advance_seconds(days * 24 * 60 * 60)
    context.now = getattr(context, "now", NOW) + timedelta(days=days)


@then("the approval is granted for that exact operation")
def then_approval_granted_for_exact_operation(context: object) -> None:
    _pending_behavior("approval granted within ceiling")


@then("the operation may execute against that approval")
def then_operation_may_execute_against_approval(context: object) -> None:
    _pending_behavior("approved operation may execute")


@then("approving outside the member authority ceiling is refused")
def then_approve_outside_ceiling_refused(context: object) -> None:
    _pending_behavior("approval refused outside ceiling")


@then('the always-allow rule is recorded for organization "{org_name}"')
def then_always_allow_recorded(context: object, org_name: str) -> None:
    _org(context, org_name)
    _pending_behavior("always-allow recorded within standing")


@then("writing an always-allow rule broader than the member standing is refused")
def then_always_allow_broader_refused(context: object) -> None:
    _pending_behavior("always-allow refused broader than standing")


@then("the expired delegation does not authorize the approval")
def then_expired_delegation_does_not_authorize(context: object) -> None:
    _pending_behavior("expired delegation does not authorize")
