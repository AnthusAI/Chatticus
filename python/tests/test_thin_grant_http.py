"""HTTP wiring for durable turn capability grants."""

from __future__ import annotations

from conftest import register_worker_headers

from chatticus.control_plane import ControlPlane
from chatticus.http.app import create_app
from chatticus.http.paths import org_path
from chatticus.http.test_server import start_test_server
from chatticus.models import ActorKind


def _turn_for_bot(plane: ControlPlane, bot_name: str = "Researcher"):
    bot = plane.create_bot("anthus", "ryan", bot_name)
    channel = plane.create_channel("anthus", "ryan", [bot.bot_id])
    _, turn = plane.post_channel_message(
        channel.channel_id,
        "anthus",
        ActorKind.HUMAN,
        "ryan",
        "grant wiring probe",
        addressed_to_bot_id=bot.bot_id,
        enqueue_turn=False,
    )
    assert turn is not None
    return bot, turn


def test_http_put_grant_requires_existing_turn() -> None:
    plane = ControlPlane()
    api = start_test_server(create_app(plane, invoke_key=""))
    worker_headers = register_worker_headers(api, "anthus")
    response = api.put(
        org_path("anthus", "/turns/missing-turn/grant"),
        json={"tools": ["read_workspace"]},
        headers=worker_headers,
    )
    assert response.status_code == 403
    api.close()


def test_http_gated_workspace_read_denies_without_grant() -> None:
    plane = ControlPlane()
    api = start_test_server(create_app(plane, invoke_key=""))
    worker_headers = register_worker_headers(api, "anthus")
    _, turn = _turn_for_bot(plane)
    response = api.post(
        org_path("anthus", f"/turns/{turn.turn_id}/workspace/read"),
        json={"user_id": "ryan", "path": "/workspace/research/notes.txt"},
        headers=worker_headers,
    )
    assert response.status_code == 403
    api.close()


def test_http_gated_workspace_read_allows_granted_scope() -> None:
    plane = ControlPlane()
    plane.ensure_computer("anthus", "ryan")
    plane.write_workspace("anthus", "ryan", "/workspace/research/notes.txt", "weekly")
    api = start_test_server(create_app(plane, invoke_key=""))
    worker_headers = register_worker_headers(api, "anthus")
    _, turn = _turn_for_bot(plane)
    grant = api.put(
        org_path("anthus", f"/turns/{turn.turn_id}/grant"),
        json={
            "tools": ["browse", "read_workspace"],
            "origins": ["https://docs.example.com"],
            "recipients": [],
            "file_scopes": ["/workspace/research"],
            "egress_classes": ["approved_origin_fetch"],
        },
        headers=worker_headers,
    )
    assert grant.status_code == 200
    allowed = api.post(
        org_path("anthus", f"/turns/{turn.turn_id}/workspace/read"),
        json={"user_id": "ryan", "path": "/workspace/research/notes.txt"},
        headers=worker_headers,
    )
    assert allowed.status_code == 200
    assert allowed.json()["content"] == "weekly"
    api.close()
