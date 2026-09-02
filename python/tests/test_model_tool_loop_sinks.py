"""Integration tests for capability-gated model tool loop dispatch."""

from __future__ import annotations

import pytest
from grant_fixtures import research_grant

from chatticus.control_plane import ControlPlane
from chatticus.http.app import create_app
from chatticus.http.client import GatedToolHttpError, HttpTurnClient
from chatticus.http.test_server import start_test_server
from chatticus.models import ActorKind, TurnEventKind
from chatticus.worker.computerless import (
    CapabilityAwareFakeTextCompletionClient,
    ComputerlessWorker,
)
from chatticus.worker.tool_dispatch import GatedToolCall, dispatch_gated_tool


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


def test_dispatch_read_workspace_allows_granted_path() -> None:
    plane = ControlPlane()
    plane.ensure_computer("anthus")
    plane.write_workspace("anthus", "/workspace/research/notes.txt", "weekly")
    api = start_test_server(create_app(plane))
    _, turn_id = _turn_with_grant(plane)
    client = HttpTurnClient(api, "anthus")
    result = dispatch_gated_tool(
        client,
        turn_id=turn_id,
        user_id="ryan",
        call=GatedToolCall(
            tool_name="read_workspace",
            arguments={"path": "/workspace/research/notes.txt"},
        ),
    )
    assert result.denied is False
    assert result.content == "weekly"
    api.close()


def test_dispatch_read_workspace_denies_ungranted_path() -> None:
    plane = ControlPlane()
    api = start_test_server(create_app(plane))
    _, turn_id = _turn_with_grant(plane)
    client = HttpTurnClient(api, "anthus")
    result = dispatch_gated_tool(
        client,
        turn_id=turn_id,
        user_id="ryan",
        call=GatedToolCall(
            tool_name="read_workspace",
            arguments={"path": "/workspace/secrets/notes.txt"},
        ),
    )
    assert result.denied is True
    assert "outside granted scopes" in result.reason
    events = plane.list_turn_events("anthus", turn_id)
    assert any(
        event.kind == TurnEventKind.TOOL_RESULT
        and event.body
        and event.body.startswith("denied:")
        for event in events
    )
    api.close()


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


def test_computerless_worker_reads_granted_file_through_http() -> None:
    plane = ControlPlane()
    plane.ensure_computer("anthus")
    plane.write_workspace("anthus", "/workspace/research/notes.txt", "weekly")
    bot = plane.create_bot("anthus", "Researcher", creator_user_id="ryan")
    channel = plane.create_channel("anthus", "ryan", [bot.bot_id])
    _, turn = plane.post_channel_message(
        channel.channel_id,
        "anthus",
        ActorKind.HUMAN,
        "ryan",
        "read workspace file /workspace/research/notes.txt",
        addressed_to_bot_id=bot.bot_id,
    )
    assert turn is not None
    plane.set_turn_capability_grant("anthus", turn.turn_id, research_grant())
    api = start_test_server(create_app(plane))
    worker = ComputerlessWorker(
        plane,
        HttpTurnClient(api, "anthus"),
        CapabilityAwareFakeTextCompletionClient(),
    )
    worker.complete_pending_for_bot(bot.bot_id)
    messages = plane.list_channel_messages(channel.channel_id, "anthus")
    bot_bodies = [
        message.body for message in messages if message.author_kind == ActorKind.BOT
    ]
    assert any(body and "weekly" in body for body in bot_bodies)
    api.close()
