"""Kernel tests for the message store and realtime API.

The thread and TurnStream APIs are rejected by docs/MESSAGING.md.
Executable specs live in features/messages.feature and
features/realtime_api.feature; implement channel and turn-scoped SSE
there before restoring kernel tests.
"""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.skip(
    reason=(
        "Thread/TurnStream API rejected; see docs/MESSAGING.md and features/*.feature"
    )
)


def _thread_with_bot(plane, name: str = "Researcher"):
    bot = plane.create_bot("anthus", "ryan", name)
    thread = plane.create_thread("anthus", "ryan", [bot.bot_id])
    return bot, thread


def test_unknown_thread_raises() -> None:
    from chatticus.control_plane import ControlPlane
    from chatticus.models import ThreadNotFoundError

    plane = ControlPlane()
    with pytest.raises(ThreadNotFoundError):
        plane.thread("missing")


def test_list_messages_rejects_other_tenant() -> None:
    from chatticus.control_plane import ControlPlane
    from chatticus.models import ThreadTenantMismatchError

    plane = ControlPlane()
    _, thread = _thread_with_bot(plane)
    with pytest.raises(ThreadTenantMismatchError):
        plane.list_messages(thread.thread_id, "other")


def test_outsider_cannot_post() -> None:
    from chatticus.control_plane import ControlPlane
    from chatticus.models import ActorKind, ActorNotInThreadError

    plane = ControlPlane()
    _, thread = _thread_with_bot(plane)
    with pytest.raises(ActorNotInThreadError):
        plane.post_message(
            thread.thread_id,
            "anthus",
            ActorKind.HUMAN,
            "alex",
            "hello",
        )


def test_addressing_a_bot_not_in_the_thread_raises() -> None:
    from chatticus.control_plane import ControlPlane
    from chatticus.models import ActorKind, ActorNotInThreadError

    plane = ControlPlane()
    researcher, thread = _thread_with_bot(plane)
    writer = plane.create_bot("anthus", "ryan", "Writer")
    with pytest.raises(ActorNotInThreadError):
        plane.post_message(
            thread.thread_id,
            "anthus",
            ActorKind.HUMAN,
            "ryan",
            "hello",
            addressed_to_bot_id=writer.bot_id,
        )
    assert plane.pending_jobs_for_bot(researcher.bot_id) == []


def test_complete_turn_stream_does_not_enqueue_another_turn() -> None:
    from chatticus.control_plane import ControlPlane
    from chatticus.models import ActorKind

    plane = ControlPlane()
    bot, thread = _thread_with_bot(plane)
    plane.post_message(
        thread.thread_id,
        "anthus",
        ActorKind.HUMAN,
        "ryan",
        "hello",
        addressed_to_bot_id=bot.bot_id,
    )
    assert len(plane.pending_jobs_for_bot(bot.bot_id)) == 1
    stream_id = plane.start_turn_stream(thread.thread_id, "anthus", bot.bot_id)
    plane.append_turn_token(stream_id, "Hi")
    plane.complete_turn_stream(stream_id)
    assert len(plane.pending_jobs_for_bot(bot.bot_id)) == 1


def test_unknown_turn_stream_raises() -> None:
    from chatticus.control_plane import ControlPlane
    from chatticus.models import TurnStreamNotFoundError

    plane = ControlPlane()
    with pytest.raises(TurnStreamNotFoundError):
        plane.append_turn_token("missing", "x")
    with pytest.raises(TurnStreamNotFoundError):
        plane.complete_turn_stream("missing")


def test_bot_from_another_user_cannot_join_thread() -> None:
    from chatticus.control_plane import ControlPlane
    from chatticus.models import ActorNotInThreadError

    plane = ControlPlane()
    plane.create_bot("anthus", "ryan", "Researcher")
    other = plane.create_bot("anthus", "alex", "Ops")
    with pytest.raises(ActorNotInThreadError):
        plane.create_thread("anthus", "ryan", [other.bot_id])
