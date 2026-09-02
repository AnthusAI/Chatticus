"""FastAPI front door: channels, messages, turn chunks, and SSE streams."""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from chatticus.capability_policy import grant_from_payload
from chatticus.capability_sinks import CapabilitySinkDenied
from chatticus.cognito_jwt import CognitoJwtVerifier, CognitoTokenError
from chatticus.control_plane import ControlPlane
from chatticus.http.principal import (
    RequireUserPrincipal,
    RequireWorkerPrincipal,
    enforce_user_principal,
    enforce_worker_principal,
    resolve_me_from_token,
    waitlist_safe,
)
from chatticus.http.sse import (
    cursor_from_last_event_id,
    format_turn_event_sse,
    turn_event_payload,
)
from chatticus.models import (
    ActorKind,
    ActorNotInChannelError,
    ChannelNotFoundError,
    ChannelTenantMismatchError,
    ChatticusError,
    ComputerNotReadyError,
    CostClass,
    NotOrganizationOwnerError,
    OrganizationNotFoundError,
    StaleAttemptError,
    TaskAccessDeniedError,
    TaskNotFoundError,
    TurnAccessDeniedError,
    TurnClaimDeniedError,
    TurnEventKind,
    TurnNotFoundError,
    TurnNotWaitingError,
    TurnReconcilingError,
    TurnTerminalError,
    WorkerRegistration,
    WorkerTenantMismatchError,
    pending_computer_tool_from_turn,
    primary_human_participant,
)
from chatticus.principal import Principal
from chatticus.signup_mode import SignupMode, signup_mode_from_env
from chatticus.worker_credentials import parse_bearer_token

logger = logging.getLogger("chatticus.http")
INVOKE_HEADER = "X-Chatticus-Invoke-Key"


TENANT_HEADER = "X-Tenant-Id"


class CreateChannelBody(BaseModel):
    """Body for POST /channels."""

    user_id: str
    bot_ids: list[str] = Field(default_factory=list)


class CreateBotBody(BaseModel):
    """Body for POST /bots."""

    name: str


class RememberBotBody(BaseModel):
    """Body for POST /bots/{bot_id}/memory."""

    key: str
    value: str


class SetComputerBody(BaseModel):
    """Body for POST /computers/stopped."""

    stopped: bool = True


class PostMessageBody(BaseModel):
    """Body for POST /channels/{channel_id}/messages."""

    author_kind: ActorKind
    author_id: str
    body: str
    addressed_to_bot_id: str | None = None
    enqueue_turn: bool = Field(
        default=True,
        description="When false, start the addressed turn without a cpu SQS job.",
    )


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


class InvokeTaskToolBody(BaseModel):
    """Body for POST /bots/{bot_id}/tasks/tool."""

    user_id: str
    action: str
    arguments: dict[str, str] = Field(default_factory=dict)


class PutTurnGrantBody(BaseModel):
    """Body for PUT /turns/{turn_id}/grant."""

    tools: list[str] = Field(default_factory=list)
    origins: list[str] = Field(default_factory=list)
    recipients: list[str] = Field(default_factory=list)
    file_scopes: list[str] = Field(default_factory=list)
    egress_classes: list[str] = Field(default_factory=list)
    ingest_classes: list[str] = Field(default_factory=list)


class ReadWorkspaceBody(BaseModel):
    """Body for POST /turns/{turn_id}/workspace/read."""

    user_id: str
    path: str


class AuthorizeBrowseBody(BaseModel):
    """Body for POST /turns/{turn_id}/browse/authorize."""

    url: str


class DenyModelToolBody(BaseModel):
    """Body for POST /turns/{turn_id}/tool/denied."""

    tool_name: str
    arguments: dict[str, str] = Field(default_factory=dict)


class RegisterWorkerBody(BaseModel):
    """Body for POST /workers/register."""

    worker_id: str
    cost_class: CostClass
    capabilities: list[str] = Field(default_factory=list)
    computer_id: str | None = None


def _registration_from_body(
    tenant_id: str, body: RegisterWorkerBody
) -> WorkerRegistration:
    return WorkerRegistration(
        worker_id=body.worker_id,
        tenant_id=tenant_id,
        cost_class=body.cost_class,
        capabilities=frozenset(body.capabilities),
        computer_id=body.computer_id,
    )


def _assert_worker_id_matches(principal: Principal, worker_id: str) -> None:
    if principal.worker_id != worker_id:
        raise HTTPException(
            status_code=403,
            detail="worker credential does not match worker_id",
        )


class MeOrganizationBody(BaseModel):
    """One organization row in GET /me."""

    tenant_id: str
    status: str


class MeResponseBody(BaseModel):
    """Membership snapshot for the signed-in user."""

    email: str
    user_id: str | None
    organizations: list[MeOrganizationBody]


class CreateOrganizationBody(BaseModel):
    """Body for POST /organizations."""

    name: str


class CreateOrganizationResponseBody(BaseModel):
    """Response for POST /organizations."""

    tenant_id: str
    name: str
    status: str


class CreateInvitationBody(BaseModel):
    """Body for POST /orgs/{tenant_id}/invitations."""

    email: str


class CreateInvitationResponseBody(BaseModel):
    """Response for POST /orgs/{tenant_id}/invitations."""

    invitation_id: str
    email: str
    expires_at: str


@dataclass
class AppState:
    """Mutable front-door state attached to each app instance."""

    plane: ControlPlane
    invoke_key: str
    environment: str
    cognito_verifier: CognitoJwtVerifier | None = None
    signup_mode: SignupMode = SignupMode.INVITATION_ONLY
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
    environment: str | None = None,
    cognito_verifier: CognitoJwtVerifier | None = None,
    signup_mode: SignupMode | None = None,
) -> FastAPI:
    """Build a FastAPI app backed by one control plane instance."""
    resolved_key = (
        invoke_key
        if invoke_key is not None
        else os.environ.get("CHATTICUS_INVOKE_KEY", "")
    ).strip()
    resolved_environment = (
        environment
        if environment is not None
        else os.environ.get("CHATTICUS_ENVIRONMENT", "local")
    ).strip() or "local"
    resolved_signup_mode = (
        signup_mode if signup_mode is not None else signup_mode_from_env()
    )
    state = AppState(
        plane=plane,
        invoke_key=resolved_key,
        environment=resolved_environment,
        cognito_verifier=cognito_verifier,
        signup_mode=resolved_signup_mode,
    )
    app = FastAPI(
        title="Chatticus control plane",
        dependencies=[Depends(_verify_invoke_key)],
    )
    app.state.chatticus = state

    @app.middleware("http")
    async def reject_tenant_header(
        request: Request, call_next: object
    ) -> JSONResponse | StreamingResponse:
        if request.headers.get(TENANT_HEADER):
            return JSONResponse(
                status_code=400,
                content={
                    "detail": (
                        f"{TENANT_HEADER} is not accepted; use "
                        "/orgs/{tenant_id}/... in the request path."
                    )
                },
            )
        return await call_next(request)  # type: ignore[misc, operator]

    org_router = APIRouter(prefix="/orgs/{tenant_id}")
    worker_router = APIRouter(dependencies=[Depends(enforce_worker_principal)])
    user_router = APIRouter(dependencies=[Depends(enforce_user_principal)])

    @app.exception_handler(ChatticusError)
    async def chatticus_error_handler(
        _request: Request, error: ChatticusError
    ) -> JSONResponse:
        status = _status_for_error(error)
        return JSONResponse(status_code=status, content={"detail": str(error)})

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "environment": state.environment}

    @waitlist_safe
    @app.get("/me")
    def get_me(request: Request) -> MeResponseBody:
        verifier = state.cognito_verifier
        if verifier is None:
            raise HTTPException(
                status_code=503,
                detail="Cognito verifier is not configured for GET /me.",
            )
        token = parse_bearer_token(request.headers.get("Authorization"))
        if token is None:
            raise HTTPException(status_code=403, detail="user credential required")
        try:
            me = resolve_me_from_token(
                state.plane, token, verifier=verifier, now=state.plane.now()
            )
        except CognitoTokenError as error:
            raise HTTPException(status_code=403, detail=str(error)) from error
        return MeResponseBody(
            email=me.email,
            user_id=me.user_id,
            organizations=[
                MeOrganizationBody(
                    tenant_id=organization.tenant_id,
                    status=organization.status.value,
                )
                for organization in me.organizations
            ],
        )

    @waitlist_safe
    @app.post("/organizations", status_code=201)
    def create_organization_route(
        request: Request, body: CreateOrganizationBody
    ) -> CreateOrganizationResponseBody:
        if state.signup_mode is not SignupMode.OPEN:
            raise HTTPException(
                status_code=403,
                detail="organization creation is not enabled on this deployment",
            )
        verifier = state.cognito_verifier
        if verifier is None:
            raise HTTPException(
                status_code=503,
                detail="Cognito verifier is not configured for POST /organizations.",
            )
        token = parse_bearer_token(request.headers.get("Authorization"))
        if token is None:
            raise HTTPException(status_code=403, detail="user credential required")
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="organization name is required")
        try:
            verified = verifier.verify_id_token(token)
        except CognitoTokenError as error:
            raise HTTPException(status_code=403, detail=str(error)) from error
        now = datetime.now(tz=UTC)
        owner = state.plane.sign_in(verified.email, now=now)
        organization = state.plane.create_organization(owner, name, now=now)
        return CreateOrganizationResponseBody(
            tenant_id=organization.tenant_id,
            name=organization.name,
            status=organization.status.value,
        )

    @org_router.post("/workers/register")
    def register_worker(
        tenant_id: str,
        body: RegisterWorkerBody,
    ) -> dict[str, str]:
        try:
            token = state.plane.register_worker(
                _registration_from_body(tenant_id, body)
            )
        except WorkerTenantMismatchError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        logger.info(
            "worker_registered tenant_id=%s worker_id=%s",
            tenant_id,
            body.worker_id,
        )
        return {"worker_id": body.worker_id, "token": token}

    @worker_router.post("/workers/{worker_id}/heartbeat")
    def heartbeat_worker(
        tenant_id: str,
        worker_id: str,
        principal: RequireWorkerPrincipal,
    ) -> dict[str, str]:
        _assert_worker_id_matches(principal, worker_id)
        state.plane.heartbeat(tenant_id, worker_id)
        logger.info(
            "worker_heartbeat tenant_id=%s worker_id=%s",
            tenant_id,
            worker_id,
        )
        return {"status": "ok"}

    @user_router.post("/invitations", status_code=201)
    def create_invitation(
        tenant_id: str,
        body: CreateInvitationBody,
        principal: RequireUserPrincipal,
    ) -> CreateInvitationResponseBody:
        if principal.user_id is None:
            raise HTTPException(status_code=403, detail="user credential required")
        email = body.email.strip()
        if not email:
            raise HTTPException(status_code=400, detail="email is required")
        try:
            invitation = state.plane.invite_by_email(
                tenant_id,
                principal.user_id,
                email,
                now=state.plane.now(),
            )
        except OrganizationNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except NotOrganizationOwnerError as error:
            raise HTTPException(status_code=403, detail=str(error)) from error
        return CreateInvitationResponseBody(
            invitation_id=invitation.invitation_id,
            email=invitation.email,
            expires_at=invitation.expires_at.isoformat(),
        )

    @user_router.post("/bots")
    def create_bot(
        tenant_id: str,
        body: CreateBotBody,
        principal: RequireUserPrincipal,
        idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
    ) -> dict[str, Any]:
        if principal.user_id is None:
            raise HTTPException(status_code=403, detail="user credential required")
        key = (idempotency_key or "").strip() or None
        bot = state.plane.create_bot(
            tenant_id,
            body.name,
            creator_user_id=principal.user_id,
            idempotency_key=key,
        )
        logger.info(
            "bot_created tenant_id=%s creator_user_id=%s bot_id=%s",
            tenant_id,
            principal.user_id,
            bot.bot_id,
        )
        return _bot_payload(bot)

    @user_router.get("/bots")
    def lookup_bot(
        tenant_id: str,
        name: str = Query(),
    ) -> dict[str, Any]:
        try:
            bot = state.plane.bot_by_name(tenant_id, name)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="bot not found") from error
        return _bot_payload(bot)

    @user_router.get("/users/{user_id}/bots")
    def list_user_bots(
        tenant_id: str,
        user_id: str,
    ) -> dict[str, Any]:
        del user_id
        bots = state.plane.list_bots(tenant_id)
        return {"bots": [_bot_payload(bot) for bot in bots]}

    @user_router.get("/users/{user_id}/channels")
    def list_user_channels(
        tenant_id: str,
        user_id: str,
    ) -> dict[str, Any]:
        channels = state.plane.list_channels(tenant_id, user_id)
        return {"channels": [_channel_payload(channel) for channel in channels]}

    @user_router.get("/users/{user_id}/turns")
    def list_user_turns(
        tenant_id: str,
        user_id: str,
    ) -> dict[str, Any]:
        turns = state.plane.list_active_turns(tenant_id, user_id)
        return {"turns": [_turn_payload(turn) for turn in turns]}

    @user_router.get("/users/{user_id}/tasks")
    def list_user_tasks(
        tenant_id: str,
        user_id: str,
    ) -> dict[str, Any]:
        tasks = state.plane.list_tasks(tenant_id, user_id)
        return {"tasks": [_task_payload(task) for task in tasks]}

    @user_router.get("/users/{user_id}/computer")
    def get_user_computer(
        tenant_id: str,
        user_id: str,
    ) -> dict[str, Any]:
        del user_id
        try:
            computer = state.plane.computer_for_organization(tenant_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="computer not found") from error
        return _computer_payload(computer)

    @user_router.get("/computer")
    def get_organization_computer(
        tenant_id: str,
    ) -> dict[str, Any]:
        try:
            computer = state.plane.computer_for_organization(tenant_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="computer not found") from error
        return _computer_payload(computer)

    @user_router.get("/bots/{bot_id}")
    def get_bot(
        tenant_id: str,
        bot_id: str,
    ) -> dict[str, Any]:
        try:
            bot = state.plane.bot(tenant_id, bot_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="bot not found") from error
        return _bot_payload(bot)

    @user_router.post("/bots/{bot_id}/memory")
    def remember_bot(
        tenant_id: str,
        bot_id: str,
        body: RememberBotBody,
    ) -> dict[str, Any]:
        try:
            state.plane.remember(tenant_id, bot_id, body.key, body.value)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="bot not found") from error
        logger.info(
            "bot_memory_written tenant_id=%s bot_id=%s key=%s",
            tenant_id,
            bot_id,
            body.key,
        )
        return _bot_payload(state.plane.bot(tenant_id, bot_id))

    @worker_router.post("/bots/{bot_id}/tasks/tool")
    def invoke_task_tool(
        tenant_id: str,
        bot_id: str,
        body: InvokeTaskToolBody,
    ) -> dict[str, Any]:
        try:
            state.plane.bot(tenant_id, bot_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="bot not found") from error
        task = state.plane.invoke_task_tool(
            tenant_id,
            body.user_id,
            bot_id,
            body.action,
            body.arguments,
        )
        logger.info(
            "task_tool_invoked tenant_id=%s bot_id=%s action=%s task_id=%s",
            tenant_id,
            bot_id,
            body.action,
            task.task_id,
        )
        return _task_payload(task)

    @user_router.get("/tasks/{task_id}")
    def get_task(
        tenant_id: str,
        task_id: str,
    ) -> dict[str, Any]:
        try:
            task = state.plane.task(tenant_id, task_id)
        except TaskNotFoundError as error:
            raise HTTPException(status_code=404, detail="task not found") from error
        return _task_payload(task)

    @user_router.post("/computers/stopped")
    def set_computer_stopped(
        tenant_id: str,
        body: SetComputerBody,
    ) -> dict[str, bool]:
        state.plane.set_computer_stopped(tenant_id, body.stopped)
        stopped = state.plane.computer_is_stopped(tenant_id)
        logger.info(
            "computer_stopped tenant_id=%s stopped=%s",
            tenant_id,
            stopped,
        )
        return {"stopped": stopped}

    @user_router.get("/computers/stopped")
    def get_computer_stopped(
        tenant_id: str,
    ) -> dict[str, bool]:
        return {"stopped": state.plane.computer_is_stopped(tenant_id)}

    @user_router.post("/channels")
    def create_channel(
        tenant_id: str,
        body: CreateChannelBody,
        idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
    ) -> dict[str, Any]:
        key = (idempotency_key or "").strip() or None
        channel = state.plane.create_channel(
            tenant_id,
            body.user_id,
            body.bot_ids,
            idempotency_key=key,
        )
        logger.info(
            "channel_created tenant_id=%s channel_id=%s user_id=%s",
            tenant_id,
            channel.channel_id,
            body.user_id,
        )
        return _channel_payload(channel)

    @user_router.get("/channels/{channel_id}")
    def get_channel(
        tenant_id: str,
        channel_id: str,
    ) -> dict[str, Any]:
        try:
            channel = state.plane.channel(tenant_id, channel_id)
        except ChannelNotFoundError as error:
            raise HTTPException(status_code=404, detail="channel not found") from error
        return _channel_payload(channel)

    @user_router.get("/channels/{channel_id}/turn")
    def get_channel_turn(
        tenant_id: str,
        channel_id: str,
    ) -> dict[str, Any]:
        try:
            state.plane.channel(tenant_id, channel_id)
        except ChannelNotFoundError as error:
            raise HTTPException(status_code=404, detail="channel not found") from error
        turn = state.plane.active_turn_for_channel(tenant_id, channel_id)
        if turn is None:
            raise HTTPException(status_code=404, detail="turn not found")
        return _turn_payload(turn)

    @user_router.post("/channels/{channel_id}/messages")
    def post_message(
        tenant_id: str,
        channel_id: str,
        body: PostMessageBody,
        idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
    ) -> dict[str, Any]:
        key = (idempotency_key or "").strip() or None
        message, started = state.plane.post_channel_message(
            channel_id,
            tenant_id,
            body.author_kind,
            body.author_id,
            body.body,
            addressed_to_bot_id=body.addressed_to_bot_id,
            enqueue_turn=body.enqueue_turn,
            idempotency_key=key,
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

    @user_router.get("/channels/{channel_id}/messages")
    def list_messages(
        tenant_id: str,
        channel_id: str,
        after: int = Query(default=0, ge=0),
    ) -> dict[str, Any]:
        messages = state.plane.list_channel_messages(channel_id, tenant_id, after)
        return {
            "messages": [_message_payload(message) for message in messages],
        }

    @worker_router.post("/turns/{turn_id}/claim")
    def claim_turn(
        tenant_id: str,
        turn_id: str,
        body: ClaimTurnBody,
        principal: RequireWorkerPrincipal,
    ) -> dict[str, Any]:
        _assert_worker_id_matches(principal, body.worker_id)
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

    @worker_router.post("/turns/{turn_id}/renew")
    def renew_turn(
        tenant_id: str,
        turn_id: str,
        body: RenewTurnBody,
        principal: RequireWorkerPrincipal,
    ) -> dict[str, Any]:
        _assert_worker_id_matches(principal, body.worker_id)
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

    @worker_router.post("/turns/{turn_id}/waiting")
    def wait_turn(
        tenant_id: str,
        turn_id: str,
        body: WaitTurnBody,
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

    @worker_router.post("/turns/{turn_id}/resume")
    def resume_turn(
        tenant_id: str,
        turn_id: str,
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

    @user_router.get("/turns/{turn_id}")
    def get_turn(
        tenant_id: str,
        turn_id: str,
    ) -> dict[str, Any]:
        try:
            turn = state.plane.turn(tenant_id, turn_id)
        except TurnNotFoundError as error:
            raise TurnAccessDeniedError(
                f"Tenant {tenant_id!r} cannot read turn {turn_id!r}."
            ) from error
        return _turn_payload(turn)

    @worker_router.put("/turns/{turn_id}/grant")
    def put_turn_grant(
        tenant_id: str,
        turn_id: str,
        body: PutTurnGrantBody,
    ) -> dict[str, Any]:
        try:
            state.plane.turn(tenant_id, turn_id)
        except TurnNotFoundError as error:
            raise TurnAccessDeniedError(
                f"Tenant {tenant_id!r} cannot grant turn {turn_id!r}."
            ) from error
        grant = grant_from_payload(body.model_dump())
        state.plane.set_turn_capability_grant(tenant_id, turn_id, grant)
        logger.info(
            "turn_grant_set tenant_id=%s turn_id=%s tools=%s",
            tenant_id,
            turn_id,
            sorted(grant.tools),
        )
        return {"turn_id": turn_id, "tools": sorted(grant.tools)}

    @worker_router.post("/turns/{turn_id}/workspace/read")
    def read_turn_workspace(
        tenant_id: str,
        turn_id: str,
        body: ReadWorkspaceBody,
    ) -> dict[str, Any]:
        try:
            state.plane.turn(tenant_id, turn_id)
        except TurnNotFoundError as error:
            raise TurnAccessDeniedError(
                f"Tenant {tenant_id!r} cannot read workspace for turn {turn_id!r}."
            ) from error
        content = state.plane.gated_read_workspace_for_model(
            tenant_id,
            turn_id,
            body.user_id,
            body.path,
        )
        logger.info(
            "gated_workspace_read tenant_id=%s turn_id=%s path=%s",
            tenant_id,
            turn_id,
            body.path,
        )
        return {"content": content}

    @worker_router.post("/turns/{turn_id}/browse/authorize")
    def authorize_turn_browse(
        tenant_id: str,
        turn_id: str,
        body: AuthorizeBrowseBody,
    ) -> dict[str, Any]:
        try:
            state.plane.turn(tenant_id, turn_id)
        except TurnNotFoundError as error:
            raise TurnAccessDeniedError(
                f"Tenant {tenant_id!r} cannot authorize browse for turn {turn_id!r}."
            ) from error
        state.plane.gated_browse_origin_for_model(tenant_id, turn_id, body.url)
        logger.info(
            "gated_browse_authorized tenant_id=%s turn_id=%s url=%s",
            tenant_id,
            turn_id,
            body.url,
        )
        return {"authorized": True, "url": body.url}

    @worker_router.post("/turns/{turn_id}/tool/denied")
    def deny_turn_model_tool(
        tenant_id: str,
        turn_id: str,
        body: DenyModelToolBody,
    ) -> dict[str, str]:
        try:
            state.plane.turn(tenant_id, turn_id)
        except TurnNotFoundError as error:
            raise TurnAccessDeniedError(
                f"Tenant {tenant_id!r} cannot deny tools for turn {turn_id!r}."
            ) from error
        state.plane.deny_model_tool_request(
            tenant_id,
            turn_id,
            body.tool_name,
            dict(body.arguments),
        )

    @user_router.get("/turns/{turn_id}/events")
    def list_turn_events(
        tenant_id: str,
        turn_id: str,
        after: int = Query(default=0, ge=0),
    ) -> dict[str, Any]:
        try:
            state.plane.turn(tenant_id, turn_id)
        except TurnNotFoundError as error:
            raise TurnAccessDeniedError(
                f"Tenant {tenant_id!r} cannot read turn {turn_id!r}."
            ) from error
        events = state.plane.list_turn_events(tenant_id, turn_id, after)
        return {
            "events": [turn_event_payload(event) for event in events],
        }

    @worker_router.post("/turns/{turn_id}/chunks")
    def post_chunk(
        tenant_id: str,
        turn_id: str,
        body: PostChunkBody,
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

    @user_router.get("/turns/{turn_id}/stream")
    async def stream_turn(
        request: Request,
        tenant_id: str,
        turn_id: str,
        last_event_id: Annotated[str | None, Header(alias="Last-Event-ID")] = None,
    ) -> StreamingResponse:
        try:
            state.plane.turn(tenant_id, turn_id)
        except TurnNotFoundError as error:
            raise TurnAccessDeniedError(
                f"Tenant {tenant_id!r} cannot watch turn {turn_id!r}."
            ) from error
        try:
            cursor = cursor_from_last_event_id(last_event_id)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

        async def event_generator() -> Any:
            state.open_sse_streams += 1
            replay_from = cursor
            logger.info(
                "sse_open tenant_id=%s turn_id=%s last_event_id=%s",
                tenant_id,
                turn_id,
                replay_from,
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
                    events = state.plane.list_turn_events(
                        tenant_id, turn_id, replay_from
                    )
                    if not events:
                        await asyncio.sleep(0.05)
                        continue
                    for event in events:
                        yield format_turn_event_sse(event)
                        replay_from = event.seq
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

    org_router.include_router(worker_router)
    org_router.include_router(user_router)
    app.include_router(org_router)

    return app


def _status_for_error(error: ChatticusError) -> int:
    if isinstance(error, CapabilitySinkDenied):
        return 403
    if isinstance(
        error,
        ChannelTenantMismatchError | TurnAccessDeniedError | ActorNotInChannelError,
    ):
        return 403
    if isinstance(error, TaskAccessDeniedError):
        return 403
    if isinstance(error, TaskNotFoundError):
        return 404
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
    if isinstance(error, OrganizationNotFoundError):
        return 404
    if isinstance(error, NotOrganizationOwnerError):
        return 403
    return 400


def _bot_payload(bot: Any) -> dict[str, Any]:
    return {
        "bot_id": bot.bot_id,
        "tenant_id": bot.tenant_id,
        "name": bot.name,
        "memory": dict(bot.memory),
    }


def _task_payload(task: Any) -> dict[str, Any]:
    return {
        "task_id": task.task_id,
        "tenant_id": task.tenant_id,
        "user_id": task.user_id,
        "title": task.title,
        "status": str(task.status),
        "evidence": task.evidence,
        "close_reason": task.close_reason,
        "created_by_bot_id": task.created_by_bot_id,
        "updated_by_bot_id": task.updated_by_bot_id,
    }


def _computer_payload(computer: Any) -> dict[str, Any]:
    return {
        "computer_id": computer.computer_id,
        "tenant_id": computer.tenant_id,
        "stopped": computer.stopped,
        "policy": str(computer.policy),
        "host_start_generation": computer.host_start_generation,
    }


def _channel_payload(channel: Any) -> dict[str, Any]:
    return {
        "channel_id": channel.channel_id,
        "tenant_id": channel.tenant_id,
        "user_id": primary_human_participant(channel),
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
