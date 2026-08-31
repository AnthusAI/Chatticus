"""FastAPI front door: channels, messages, turn chunks, and SSE streams."""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
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
    ComputerNotReadyError,
    StaleAttemptError,
    TurnAccessDeniedError,
    TurnClaimDeniedError,
    TurnEventKind,
    TurnNotFoundError,
    TurnNotWaitingError,
    TurnReconcilingError,
    TurnTerminalError,
    pending_computer_tool_from_turn,
)

logger = logging.getLogger("chatticus.http")
INVOKE_HEADER = "X-Chatticus-Invoke-Key"


class CreateChannelBody(BaseModel):
    """Body for POST /channels."""

    user_id: str
    bot_ids: list[str] = Field(default_factory=list)


class CreateBotBody(BaseModel):
    """Body for POST /bots."""

    user_id: str
    name: str


class SetComputerBody(BaseModel):
    """Body for POST /computers/stopped."""

    user_id: str
    stopped: bool = True


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
    fence_token: int


class ClaimTurnBody(BaseModel):
    """Body for POST /turns/{turn_id}/claim."""

    worker_id: str


class RenewTurnBody(BaseModel):
    """Body for POST /turns/{turn_id}/renew."""

    worker_id: str
    fence_token: int
    job_id: str | None = None


class WaitTurnBody(BaseModel):
    """Body for POST /turns/{turn_id}/waiting."""

    gate: str
    fence_token: int


@dataclass
class AppState:
    """Mutable front-door state attached to each app instance."""

    plane: ControlPlane
    invoke_key: str
    open_sse_streams: int = 0


def _verify_invoke_key(request: Request) -> None:
    """Reject calls that omit the invoke key when one is configured."""
    if request.url.path == "/health":
        return
    expected = request.app.state.chatticus.invoke_key
    if expected and request.headers.get(INVOKE_HEADER) != expected:
        raise HTTPException(status_code=403, detail="invoke key required")


def create_app(
    plane: ControlPlane,
    *,
    invoke_key: str | None = None,
) -> FastAPI:
    """Build a FastAPI app backed by one control plane instance."""
    resolved_key = (
        invoke_key
        if invoke_key is not None
        else os.environ.get("CHATTICUS_INVOKE_KEY", "")
    ).strip()
    state = AppState(plane=plane, invoke_key=resolved_key)
    app = FastAPI(
        title="Chatticus control plane",
        dependencies=[Depends(_verify_invoke_key)],
    )
    app.state.chatticus = state

    @app.exception_handler(ChatticusError)
    async def chatticus_error_handler(
        _request: Request, error: ChatticusError
    ) -> JSONResponse:
        status = _status_for_error(error)
        return JSONResponse(status_code=status, content={"detail": str(error)})

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/bots")
    def create_bot(
        body: CreateBotBody,
        tenant_id: Annotated[str, Header(alias="X-Tenant-Id")],
    ) -> dict[str, str]:
        bot = state.plane.create_bot(tenant_id, body.user_id, body.name)
        logger.info(
            "bot_created tenant_id=%s user_id=%s bot_id=%s",
            tenant_id,
            body.user_id,
            bot.bot_id,
        )
        return {
            "bot_id": bot.bot_id,
            "tenant_id": bot.tenant_id,
            "user_id": bot.user_id,
            "name": bot.name,
        }

    @app.post("/computers/stopped")
    def set_computer_stopped(
        body: SetComputerBody,
        tenant_id: Annotated[str, Header(alias="X-Tenant-Id")],
    ) -> dict[str, bool]:
        state.plane.set_computer_stopped(tenant_id, body.user_id, body.stopped)
        stopped = state.plane.computer_is_stopped(tenant_id, body.user_id)
        logger.info(
            "computer_stopped tenant_id=%s user_id=%s stopped=%s",
            tenant_id,
            body.user_id,
            stopped,
        )
        return {"stopped": stopped}

    @app.get("/computers/stopped")
    def get_computer_stopped(
        tenant_id: Annotated[str, Header(alias="X-Tenant-Id")],
        user_id: str = Query(),
    ) -> dict[str, bool]:
        return {"stopped": state.plane.computer_is_stopped(tenant_id, user_id)}

    @app.post("/channels")
    def create_channel(
        body: CreateChannelBody,
        tenant_id: Annotated[str, Header(alias="X-Tenant-Id")],
    ) -> dict[str, Any]:
        channel = state.plane.create_channel(tenant_id, body.user_id, body.bot_ids)
        logger.info(
            "channel_created tenant_id=%s channel_id=%s user_id=%s",
            tenant_id,
            channel.channel_id,
            body.user_id,
        )
        return _channel_payload(channel)

    @app.post("/channels/{channel_id}/messages")
    def post_message(
        channel_id: str,
        body: PostMessageBody,
        tenant_id: Annotated[str, Header(alias="X-Tenant-Id")],
    ) -> dict[str, Any]:
        message, started = state.plane.post_channel_message(
            channel_id,
            tenant_id,
            body.author_kind,
            body.author_id,
            body.body,
            addressed_to_bot_id=body.addressed_to_bot_id,
        )
        turn_id = started.turn_id if started is not None else None
        logger.info(
            "message_posted tenant_id=%s channel_id=%s turn_id=%s seq=%s",
            tenant_id,
            channel_id,
            turn_id,
            message.seq,
        )
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

    @app.post("/turns/{turn_id}/claim")
    def claim_turn(
        turn_id: str,
        body: ClaimTurnBody,
        tenant_id: Annotated[str, Header(alias="X-Tenant-Id")],
    ) -> dict[str, Any]:
        attempt = state.plane.claim_turn_attempt(tenant_id, turn_id, body.worker_id)
        if attempt is None:
            raise TurnClaimDeniedError(
                f"Turn {turn_id!r} is owned by another unexpired attempt."
            )
        logger.info(
            "turn_claimed tenant_id=%s turn_id=%s worker_id=%s acquired=%s fence=%s",
            tenant_id,
            turn_id,
            body.worker_id,
            attempt.acquired,
            attempt.fence_token,
        )
        return {
            "attempt_id": attempt.attempt_id,
            "fence_token": attempt.fence_token,
            "acquired": attempt.acquired,
            "lease_expires_at": attempt.lease_expires_at.isoformat(),
        }

    @app.post("/turns/{turn_id}/renew")
    def renew_turn(
        turn_id: str,
        body: RenewTurnBody,
        tenant_id: Annotated[str, Header(alias="X-Tenant-Id")],
    ) -> dict[str, Any]:
        job = None
        if body.job_id is not None:
            job = state.plane.job_for_turn(tenant_id, turn_id)
            if job is not None and job.job_id != body.job_id:
                job = None
        attempt = state.plane.renew_turn_lease(
            tenant_id,
            turn_id,
            body.worker_id,
            body.fence_token,
            job=job,
        )
        if attempt is None:
            raise TurnClaimDeniedError(
                f"Turn {turn_id!r} rejected renewal for fence {body.fence_token}."
            )
        logger.info(
            "turn_renewed tenant_id=%s turn_id=%s worker_id=%s fence=%s",
            tenant_id,
            turn_id,
            body.worker_id,
            body.fence_token,
        )
        return {
            "attempt_id": attempt.attempt_id,
            "fence_token": attempt.fence_token,
            "lease_expires_at": attempt.lease_expires_at.isoformat(),
        }

    @app.post("/turns/{turn_id}/waiting")
    def wait_turn(
        turn_id: str,
        body: WaitTurnBody,
        tenant_id: Annotated[str, Header(alias="X-Tenant-Id")],
    ) -> dict[str, str]:
        event = state.plane.emit_turn_waiting(
            tenant_id,
            turn_id,
            body.gate,
            fence_token=body.fence_token,
        )
        state.plane.release_turn_claim_for_waiting(
            tenant_id,
            turn_id,
            fence_token=body.fence_token,
        )
        logger.info(
            "turn_waiting tenant_id=%s turn_id=%s gate=%s",
            tenant_id,
            turn_id,
            body.gate,
        )
        return {"status": "ok", "kind": event.kind, "gate": body.gate}

    @app.post("/turns/{turn_id}/resume")
    def resume_turn(
        turn_id: str,
        tenant_id: Annotated[str, Header(alias="X-Tenant-Id")],
    ) -> dict[str, Any]:
        job = state.plane.resume_waiting_turn(tenant_id, turn_id)
        turn = state.plane.turn(tenant_id, turn_id)
        logger.info(
            "turn_resume tenant_id=%s turn_id=%s job_id=%s gate=%s",
            tenant_id,
            turn_id,
            job.job_id,
            turn.waiting_for,
        )
        return {
            "status": "ok",
            "turn_id": turn_id,
            "job_id": job.job_id,
            "gate": turn.waiting_for or "",
            "required_capabilities": sorted(job.required_capabilities),
        }

    @app.get("/turns/{turn_id}")
    def get_turn(
        turn_id: str,
        tenant_id: Annotated[str, Header(alias="X-Tenant-Id")],
    ) -> dict[str, Any]:
        try:
            turn = state.plane.turn(tenant_id, turn_id)
        except TurnNotFoundError as error:
            raise TurnAccessDeniedError(
                f"Tenant {tenant_id!r} cannot read turn {turn_id!r}."
            ) from error
        return _turn_payload(turn)

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
            fence_token=body.fence_token,
        )
        logger.info(
            "chunk_posted tenant_id=%s turn_id=%s complete=%s",
            tenant_id,
            turn_id,
            body.complete,
        )
        return {"status": "ok"}

    @app.get("/turns/{turn_id}/stream")
    async def stream_turn(
        request: Request,
        turn_id: str,
        tenant_id: Annotated[str, Header(alias="X-Tenant-Id")],
        after_seq: int = Query(default=0, ge=0),
    ) -> StreamingResponse:
        try:
            state.plane.turn(tenant_id, turn_id)
        except TurnNotFoundError as error:
            raise TurnAccessDeniedError(
                f"Tenant {tenant_id!r} cannot watch turn {turn_id!r}."
            ) from error

        async def event_generator() -> Any:
            state.open_sse_streams += 1
            cursor = after_seq
            logger.info(
                "sse_open tenant_id=%s turn_id=%s after_seq=%s",
                tenant_id,
                turn_id,
                after_seq,
            )
            try:
                while True:
                    if await request.is_disconnected():
                        logger.info(
                            "sse_disconnect tenant_id=%s turn_id=%s",
                            tenant_id,
                            turn_id,
                        )
                        return
                    events = state.plane.list_turn_events(tenant_id, turn_id, cursor)
                    if not events:
                        await asyncio.sleep(0.05)
                        continue
                    for event in events:
                        yield format_turn_event_sse(event)
                        cursor = event.seq
                        if event.kind in (
                            TurnEventKind.TURN_COMPLETED,
                            TurnEventKind.TURN_FAILED,
                            TurnEventKind.TURN_RECONCILING,
                        ):
                            logger.info(
                                "sse_complete tenant_id=%s turn_id=%s",
                                tenant_id,
                                turn_id,
                            )
                            return
            finally:
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
    if isinstance(error, StaleAttemptError | TurnClaimDeniedError):
        return 409
    if isinstance(
        error,
        TurnReconcilingError
        | TurnTerminalError
        | TurnNotWaitingError
        | ComputerNotReadyError,
    ):
        return 409
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


def _turn_payload(turn: Any) -> dict[str, Any]:
    pending = None
    snapshot = pending_computer_tool_from_turn(turn)
    if snapshot is not None:
        pending = {
            "action_id": snapshot.action_id,
            "tool_name": snapshot.tool_name,
            "arguments": dict(snapshot.arguments),
        }
    return {
        "turn_id": turn.turn_id,
        "tenant_id": turn.tenant_id,
        "channel_id": turn.channel_id,
        "bot_id": turn.bot_id,
        "status": turn.status.value,
        "waiting_for": turn.waiting_for,
        "pending_computer_tool": pending,
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
