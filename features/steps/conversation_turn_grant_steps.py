"""Behave steps for the household conversation turn grant."""

from __future__ import annotations

from behave import then, when

from chatticus.capability_policy import household_conversation_grant


def _active_turn_id(context: object) -> str:
    turn_id = getattr(context, "last_turn_id", None)
    if turn_id is None:
        raise AssertionError("No turn is active in this scenario.")
    return turn_id


def _active_tenant_id(context: object) -> str:
    channel = getattr(context, "last_channel", None)
    if channel is not None:
        return channel.tenant_id
    bot = next(iter(getattr(context, "bots_by_name", {}).values()), None)
    if bot is not None:
        return bot.tenant_id
    return "anthus"


@when('user "{user_id}" of tenant "{tenant_id}" opens a channel with bots:')
def when_user_opens_channel(context: object, user_id: str, tenant_id: str) -> None:
    from messaging_steps import when_open_channel

    when_open_channel(context, tenant_id, user_id)


@then("the active turn carries the household conversation grant")
def then_active_turn_carries_conversation_grant(context: object) -> None:
    tenant_id = _active_tenant_id(context)
    turn_id = _active_turn_id(context)
    grant = context.plane.capability_policy_for(tenant_id, turn_id).grant
    assert grant == household_conversation_grant()


@then("the active turn has no task grant")
def then_active_turn_has_no_task_grant(context: object) -> None:
    tenant_id = _active_tenant_id(context)
    turn_id = _active_turn_id(context)
    grant = context.plane.capability_policy_for(tenant_id, turn_id).grant
    assert grant is None
