"""FastAPI front door: channels, messages, turn chunks, and SSE streams."""

from __future__ import annotations

import queue
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Any

from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from chatticus.control_plane import ControlPlane
from chatticus.http.sse import format_turn_event_sse
from chatticus.models import (
    ActorKind,
    ActorNotInChannelError,
    ChannelNotFoundError,
    ChannelTenantMismatchError,
    ChatticusError,
    TurnAccessDeniedError,
    TurnEventKind,
    TurnNotFoundError,
    TurnStatus,
)


class CreateChannelBody(BaseModel):
    """Body for POST /channels."""

    user_id: str
    bot_ids: list[str] = Field(default_factory=list)


class PostMessageBody(BaseModel):
    """Body for POST /channels/{channel_id}/messages."""

    author_kind: ActorKind
    author_id: str
    body: str
    addressed_to_bot_id: str | None = None


class PostChunkBody(BaseModel):
    """Body for POST /turns/{turn_id}/chunks."""

    token: str
    complete: bool = False


@dataclass
class AppState:
    """Mutable front-door state attached to each app instance."""

    plane: ControlPlane
    open_sse_streams: int = 0


def create_app(plane: ControlPlane) -> FastAPI:
    """Build a FastAPI app backed by one control plane instance."""
    state = AppState(plane=plane)
    app = FastAPI(title="Chatticus control plane")
    app.state.chatticus = state

    @app.exception_handler(ChatticusError)
    async def chatticus_error_handler(
        _request: Request, error: ChatticusError
    ) -> JSONResponse:
        status = _status_for_error(error)
        return JSONResponse(status_code=status, content={"detail": str(error)})

    @app.post("/channels")
    def create_channel(
        body: CreateChannelBody,
        tenant_id: Annotated[str, Header(alias="X-Tenant-Id")],
    ) -> dict[str, Any]:
        channel = state.plane.create_channel(tenant_id, body.user_id, body.bot_ids)
        return _channel_payload(channel)

    @app.post("/channels/{channel_id}/messages")
    def post_message(
        channel_id: str,
        body: PostMessageBody,
        tenant_id: Annotated[str, Header(alias="X-Tenant-Id")],
    ) -> dict[str, Any]:
        message = state.plane.post_channel_message(
            channel_id,
            tenant_id,
            body.author_kind,
            body.author_id,
            body.body,
            addressed_to_bot_id=body.addressed_to_bot_id,
        )
        turn_id: str | None = None
        if body.addressed_to_bot_id is not None:
            jobs = state.plane.pending_jobs_for_bot(body.addressed_to_bot_id)
            if jobs:
                turn_id = jobs[-1].turn_id
        return {
            "message": _message_payload(message),
            "turn_id": turn_id,
        }

    @app.get("/channels/{channel_id}/messages")
    def list_messages(
        channel_id: str,
        tenant_id: Annotated[str, Header(alias="X-Tenant-Id")],
        after_seq: int = Query(default=0, ge=0),
    ) -> dict[str, Any]:
        messages = state.plane.list_channel_messages(channel_id, tenant_id, after_seq)
        return {
            "messages": [_message_payload(message) for message in messages],
        }

    @app.post("/turns/{turn_id}/chunks")
    def post_chunk(
        turn_id: str,
        body: PostChunkBody,
        tenant_id: Annotated[str, Header(alias="X-Tenant-Id")],
    ) -> dict[str, str]:
        state.plane.post_turn_chunk(
            turn_id,
            tenant_id,
            body.token,
            complete=body.complete,
        )
        return {"status": "ok"}

    @app.get("/turns/{turn_id}/stream")
    def stream_turn(
        turn_id: str,
        tenant_id: Annotated[str, Header(alias="X-Tenant-Id")],
        after_seq: int = Query(default=0, ge=0),
    ) -> StreamingResponse:
        owning_tenant = state.plane._turn_tenants.get(turn_id)
        if owning_tenant is None:
            raise HTTPException(status_code=404, detail=f"Turn {turn_id!r} not found.")
        if owning_tenant != tenant_id:
            raise TurnAccessDeniedError(
                f"Tenant {tenant_id!r} cannot watch turn {turn_id!r}."
            )

        def event_generator() -> Any:
            state.open_sse_streams += 1
            event_queue = state.plane.subscribe_turn_events(turn_id)
            live_buffer: list[Any] = []
            cursor = after_seq

            def collect_live() -> None:
                while True:
                    try:
                        live_event = event_queue.get(timeout=0.05)
                    except queue.Empty:
                        if (
                            state.plane.turn(owning_tenant, turn_id).status
                            == TurnStatus.COMPLETED
                        ):
                            break
                        continue
                    if live_event is None:
                        break
                    live_buffer.append(live_event)

            collector = threading.Thread(target=collect_live, daemon=True)
            collector.start()
            try:
                for event in state.plane._messaging_store.list_turn_events(
                    owning_tenant, turn_id, after_seq
                ):
                    yield format_turn_event_sse(event)
                    cursor = event.seq
                while collector.is_alive() or live_buffer:
                    while live_buffer:
                        live_event = live_buffer.pop(0)
                        if live_event.seq <= cursor:
                            continue
                        yield format_turn_event_sse(live_event)
                        cursor = live_event.seq
                        if live_event.kind == TurnEventKind.TURN_COMPLETED:
                            collector.join(timeout=0.1)
                            return
                    time.sleep(0.01)
            finally:
                state.plane.unsubscribe_turn_events(turn_id, event_queue)
                state.open_sse_streams -= 1

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        )

    return app


def _status_for_error(error: ChatticusError) -> int:
    if isinstance(
        error,
        ChannelTenantMismatchError | TurnAccessDeniedError | ActorNotInChannelError,
    ):
        return 403
    if isinstance(error, ChannelNotFoundError | TurnNotFoundError):
        return 404
    return 400


def _channel_payload(channel: Any) -> dict[str, Any]:
    return {
        "channel_id": channel.channel_id,
        "tenant_id": channel.tenant_id,
        "user_id": channel.user_id,
        "participants": [
            {"kind": participant.kind, "actor_id": participant.actor_id}
            for participant in channel.participants
        ],
        "next_seq": channel.next_seq,
    }


def _message_payload(message: Any) -> dict[str, Any]:
    created_at = message.created_at
    if isinstance(created_at, datetime):
        created_at = created_at.isoformat()
    return {
        "message_id": message.message_id,
        "channel_id": message.channel_id,
        "tenant_id": message.tenant_id,
        "seq": message.seq,
        "author_kind": message.author_kind,
        "author_id": message.author_id,
        "body": message.body,
        "addressed_to_bot_id": message.addressed_to_bot_id,
        "created_at": created_at,
    }
