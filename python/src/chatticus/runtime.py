"""Process-wide wiring for Lambda and local .env-backed runs."""

from __future__ import annotations

import json
import logging
import os
from typing import TYPE_CHECKING, Any

from chatticus.control_plane import ControlPlane
from chatticus.email_sender import (
    email_sender_from_env,
    waitlist_confirmation_base_url_from_env,
)
from chatticus.messaging.store import DynamoMessagingStore
from chatticus.models import ComputerPolicy, TurnJob
from chatticus.turn_recovery import TurnDeadlineScheduler
from chatticus.worker.openai_completion import load_local_env

if TYPE_CHECKING:
    from chatticus.cognito_jwt import CognitoJwtVerifier

logger = logging.getLogger("chatticus.runtime")


def plane_from_env() -> ControlPlane:
    """Build a control plane from Lambda or local environment variables.

    Turn recovery is enabled when Dynamo messaging and EventBridge Scheduler
    transport are configured. Logical-enqueue dedup is durable when
    ``CHATTICUS_MESSAGING_TABLE`` is set.
    """
    load_local_env()
    table_name = os.environ.get("CHATTICUS_MESSAGING_TABLE", "").strip()
    store = DynamoMessagingStore(table_name) if table_name else None
    queue_url = os.environ.get("CHATTICUS_TURN_QUEUE_URL", "").strip()
    computer_queue_url = os.environ.get("CHATTICUS_COMPUTER_TURN_QUEUE_URL", "").strip()
    deadline_scheduler = _deadline_scheduler_from_env()
    recovery_enabled = store is not None and deadline_scheduler is not None
    return ControlPlane(
        messaging_store=store,
        turn_enqueued=_sqs_enqueuer(queue_url) if queue_url else None,
        computer_enqueued=(
            _sqs_enqueuer(computer_queue_url) if computer_queue_url else None
        ),
        deadline_scheduler=deadline_scheduler,
        recovery_enabled=recovery_enabled,
        wall_clock=True,
        email_sender=email_sender_from_env(),
        waitlist_confirmation_base_url=waitlist_confirmation_base_url_from_env(),
    )


def cognito_verifier_from_env() -> CognitoJwtVerifier | None:
    """Build a Cognito JWT verifier from Lambda environment or SSM."""
    from chatticus.cloud_environments import (
        CLOUD_ENVIRONMENTS,
        parse_cloud_environment,
        resolve_cognito_config,
    )
    from chatticus.cognito_jwt import CognitoConfig, CognitoJwtVerifier

    environment = os.environ.get("CHATTICUS_ENVIRONMENT", "local").strip() or "local"
    if environment in CLOUD_ENVIRONMENTS:
        try:
            return CognitoJwtVerifier(
                resolve_cognito_config(parse_cloud_environment(environment))
            )
        except LookupError:
            return None

    issuer = os.environ.get("CHATTICUS_COGNITO_ISSUER", "").strip().rstrip("/")
    client_id = os.environ.get("CHATTICUS_COGNITO_CLIENT_ID", "").strip()
    if not (issuer and client_id):
        return None
    jwks_url = os.environ.get("CHATTICUS_COGNITO_JWKS_URL", "").strip()
    return CognitoJwtVerifier(
        CognitoConfig(
            issuer=issuer,
            client_id=client_id,
            jwks_url=jwks_url or f"{issuer}/.well-known/jwks.json",
        )
    )


def _deadline_scheduler_from_env() -> TurnDeadlineScheduler | None:
    group = os.environ.get("CHATTICUS_TURN_DEADLINE_SCHEDULE_GROUP", "").strip()
    target_arn = os.environ.get("CHATTICUS_TURN_DEADLINE_TARGET_ARN", "").strip()
    role_arn = os.environ.get("CHATTICUS_TURN_DEADLINE_ROLE_ARN", "").strip()
    if not (group and target_arn and role_arn):
        return None
    from chatticus.deadline.scheduler import EventBridgeTurnDeadlineScheduler

    return EventBridgeTurnDeadlineScheduler(group, target_arn, role_arn)


def job_from_queue_payload(payload: dict[str, Any]) -> TurnJob:
    """Rebuild a turn job from an SQS message body."""
    capabilities = payload.get("required_capabilities") or ["cpu"]
    return TurnJob(
        job_id=payload["job_id"],
        tenant_id=payload["tenant_id"],
        required_capabilities=frozenset(capabilities),
        computer_policy=ComputerPolicy(payload.get("computer_policy", "prefer_local")),
        computer_id=payload.get("computer_id"),
        user_id=payload.get("user_id"),
        bot_id=payload.get("bot_id"),
        turn_id=payload.get("turn_id"),
    )


def _sqs_enqueuer(queue_url: str):
    def enqueue(job: TurnJob) -> None:
        import boto3

        if job.turn_id is None:
            return
        body = json.dumps(
            {
                "job_id": job.job_id,
                "tenant_id": job.tenant_id,
                "turn_id": job.turn_id,
                "bot_id": job.bot_id,
                "user_id": job.user_id,
                "computer_id": job.computer_id,
                "computer_policy": job.computer_policy,
                "required_capabilities": sorted(job.required_capabilities),
            }
        )
        boto3.client("sqs").send_message(QueueUrl=queue_url, MessageBody=body)
        logger.info(
            "turn_enqueued tenant_id=%s turn_id=%s attempt_id=%s",
            job.tenant_id,
            job.turn_id,
            job.job_id,
        )

    return enqueue
