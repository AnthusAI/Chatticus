"""Tests for the household conversation turn grant preset."""

from __future__ import annotations

from grant_fixtures import conversation_grant, research_grant

from chatticus.capability_policy import household_conversation_grant
from chatticus.control_plane import ControlPlane
from chatticus.models import ActorKind


def test_household_conversation_grant_matches_fixture() -> None:
    assert household_conversation_grant() == conversation_grant()


def test_human_started_turn_receives_conversation_grant() -> None:
    plane = ControlPlane()
    bot = plane.create_bot("anthus", "Researcher", creator_user_id="ryan")
    channel = plane.create_channel("anthus", "ryan", [bot.bot_id])
    _, turn = plane.post_channel_message(
        channel.channel_id,
        "anthus",
        ActorKind.HUMAN,
        "ryan",
        "hello",
        addressed_to_bot_id=bot.bot_id,
    )
    assert turn is not None
    grant = plane.capability_policy_for("anthus", turn.turn_id).grant
    assert grant == household_conversation_grant()


def test_bot_started_turn_has_no_conversation_grant() -> None:
    plane = ControlPlane()
    researcher = plane.create_bot("anthus", "Researcher", creator_user_id="ryan")
    writer = plane.create_bot("anthus", "Writer", creator_user_id="ryan")
    channel = plane.create_channel("anthus", "ryan", [researcher.bot_id, writer.bot_id])
    _, turn = plane.post_channel_message(
        channel.channel_id,
        "anthus",
        ActorKind.BOT,
        researcher.bot_id,
        "handoff",
        addressed_to_bot_id=writer.bot_id,
    )
    assert turn is not None
    assert plane.capability_policy_for("anthus", turn.turn_id).grant is None


def test_create_bot_does_not_attach_conversation_grant() -> None:
    plane = ControlPlane()
    bot = plane.create_bot("anthus", "LiveCreate", creator_user_id="ryan")
    assert bot.name == "LiveCreate"
    assert not plane._messaging_store._turn_grants  # type: ignore[attr-defined]


def test_explicit_grant_replaces_conversation_preset() -> None:
    plane = ControlPlane()
    bot = plane.create_bot("anthus", "Researcher", creator_user_id="ryan")
    channel = plane.create_channel("anthus", "ryan", [bot.bot_id])
    _, turn = plane.post_channel_message(
        channel.channel_id,
        "anthus",
        ActorKind.HUMAN,
        "ryan",
        "hello",
        addressed_to_bot_id=bot.bot_id,
    )
    assert turn is not None
    plane.set_turn_capability_grant("anthus", turn.turn_id, research_grant())
    grant = plane.capability_policy_for("anthus", turn.turn_id).grant
    assert grant == research_grant()
    assert grant != household_conversation_grant()
