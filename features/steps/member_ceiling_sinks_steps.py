"""Behave steps for member authority ceiling enforcement at capability sinks."""

from __future__ import annotations

from behave import given, then, when

from chatticus.models import ActorKind


def _member_user_id(context: object, email: str) -> str:
    identity = getattr(context, "identities_by_email", {}).get(email)
    if identity is None:
        msg = f"Unknown member {email!r}."
        raise AssertionError(msg)
    return identity.user_id


@given('tenant "{tenant_id}" member "{email}" has a bot named "{name}"')
def given_member_bot(context: object, tenant_id: str, email: str, name: str) -> None:
    user_id = _member_user_id(context, email)
    bot = context.plane.create_bot(tenant_id, name, creator_user_id=user_id)
    context.bots_by_name[name] = bot
    context.last_acting_user_id = user_id


@when('member "{email}" asks bot "{bot_name}" to "{message}"')
def when_member_asks_bot(
    context: object, email: str, bot_name: str, message: str
) -> None:
    user_id = _member_user_id(context, email)
    bot = context.bots_by_name[bot_name]
    channel = context.plane.create_channel(bot.tenant_id, user_id, [bot.bot_id])
    _, turn = context.plane.post_channel_message(
        channel.channel_id,
        bot.tenant_id,
        ActorKind.HUMAN,
        user_id,
        body=message,
        addressed_to_bot_id=bot.bot_id,
    )
    assert turn is not None
    context.last_turn_id = turn.turn_id
    context.last_channel = channel
    context.worker_bot_id = bot.bot_id
    context.policy_turn_id = turn.turn_id
    source_grant = context.plane.capability_policy_for(
        bot.tenant_id, "ceiling-sink-turn"
    ).grant
    if source_grant is not None:
        context.plane.set_turn_capability_grant(
            bot.tenant_id, turn.turn_id, source_grant
        )


@then("the member authority ceiling denial is recorded for the turn")
def then_member_ceiling_denial_recorded(context: object) -> None:
    policy = context.plane.capability_policy_for("anthus", context.last_turn_id)
    assert policy.denials
    assert policy.denials[-1].reason == "exceeds member authority standing"
