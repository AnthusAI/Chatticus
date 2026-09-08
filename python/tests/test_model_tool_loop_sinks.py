"""HTTP deny-model-tool regression for capability-gated dispatch."""

from __future__ import annotations

import pytest
from grant_fixtures import research_grant

from chatticus.control_plane import ControlPlane
from chatticus.http.app import create_app
from chatticus.http.client import GatedToolHttpError, HttpTurnClient
from chatticus.http.test_server import start_test_server
from chatticus.models import ActorKind, TurnEventKind


def _turn_with_grant(plane: ControlPlane) -> tuple[str, str]:
    bot = plane.create_bot("anthus", "Researcher", creator_user_id="ryan")
    channel = plane.create_channel("anthus", "ryan", [bot.bot_id])
    _, turn = plane.post_channel_message(
        channel.channel_id,
        "anthus",
        ActorKind.HUMAN,
        "ryan",
        "probe",
        addressed_to_bot_id=bot.bot_id,
    )
    assert turn is not None
    plane.set_turn_capability_grant("anthus", turn.turn_id, research_grant())
    return bot.bot_id, turn.turn_id


def test_deny_model_tool_records_send_denial() -> None:
    plane = ControlPlane()
    api = start_test_server(create_app(plane))
    _, turn_id = _turn_with_grant(plane)
    client = HttpTurnClient(api, "anthus")
    with pytest.raises(GatedToolHttpError) as error:
        client.deny_model_tool(
            turn_id,
            "send",
            {"recipient": "exfil@evil.example"},
        )
    assert "not granted" in str(error.value).lower()
    events = plane.list_turn_events("anthus", turn_id)
    assert any(
        event.kind == TurnEventKind.TOOL_CALL and event.body == "send"
        for event in events
    )
    api.close()
