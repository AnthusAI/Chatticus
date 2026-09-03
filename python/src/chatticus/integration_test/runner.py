"""Smoke-tier live-stack integration test runner."""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4

import httpx

from chatticus.cloud_environments import (
    parse_cloud_environment,
    resolve_invoke_key_for_environment,
    resolve_thin_turn_base_url,
)
from chatticus.http.app import INVOKE_HEADER
from chatticus.http.integration_test_auth import INTEGRATION_TEST_SESSION_PATH
from chatticus.http.paths import org_path
from chatticus.http.worker_auth import register_worker_bearer
from chatticus.integration_test.sigv4 import (
    build_sts_get_caller_identity_headers_from_session,
)
from chatticus.integration_test.sse import parse_sse_frames
from chatticus.models import ActorKind


@dataclass
class SmokeRunResult:
    """Structured result from one smoke-tier run."""

    status: str
    checks: list[str] = field(default_factory=list)
    error: str | None = None


class SameOriginApiClient:
    """httpx wrapper that keeps /api on same-origin site URLs."""

    def __init__(self, api_base: str, **kwargs: Any) -> None:
        root = api_base.rstrip("/")
        if root.endswith("/api"):
            self._client = httpx.Client(base_url=f"{root[:-4]}/", **kwargs)
            self._prefix = "/api"
        else:
            self._client = httpx.Client(base_url=f"{root}/", **kwargs)
            self._prefix = ""

    def get(self, path: str, **kwargs: Any) -> httpx.Response:
        return self._client.get(f"{self._prefix}{path}", **kwargs)

    def post(self, path: str, **kwargs: Any) -> httpx.Response:
        return self._client.post(f"{self._prefix}{path}", **kwargs)

    def stream(self, method: str, path: str, **kwargs: Any) -> Any:
        return self._client.stream(method, f"{self._prefix}{path}", **kwargs)

    def close(self) -> None:
        self._client.close()


def _session_bearer(
    client: SameOriginApiClient,
    *,
    base_headers: dict[str, str],
    boto_session: Any,
) -> str:
    sts_headers = build_sts_get_caller_identity_headers_from_session(boto_session)
    response = client.post(
        INTEGRATION_TEST_SESSION_PATH,
        headers={**base_headers, **sts_headers},
    )
    if response.status_code != 200:
        msg = f"session exchange failed: {response.status_code} {response.text[:300]}"
        raise RuntimeError(msg)
    token = response.json().get("token")
    if not token:
        raise RuntimeError("session exchange returned no token")
    return str(token)


def run_smoke(
    *,
    environment: str | None = None,
    tenant_id: str | None = None,
    user_id: str | None = None,
    boto_session: Any | None = None,
) -> SmokeRunResult:
    """Run the smoke-tier live integration test against one named environment."""
    checks: list[str] = []
    resolved_environment = parse_cloud_environment(
        environment
        or os.environ.get("CHATTICUS_INTEGRATION_TEST_ENVIRONMENT", "development")
    )
    resolved_tenant = (
        tenant_id
        or os.environ.get("CHATTICUS_INTEGRATION_TEST_TENANT_ID", "integration-test")
    ).strip()
    resolved_user = (
        user_id
        or os.environ.get(
            "CHATTICUS_INTEGRATION_TEST_USER_ID", "integration-test-runner"
        )
    ).strip()
    try:
        base_url = resolve_thin_turn_base_url(resolved_environment)
        invoke_key = resolve_invoke_key_for_environment(resolved_environment)
    except LookupError as error:
        return SmokeRunResult(status="fail", error=str(error))

    if boto_session is None:
        import boto3

        boto_session = boto3.Session()

    invoke_headers = {INVOKE_HEADER: invoke_key}
    with SameOriginApiClient(base_url, timeout=900.0) as client:
        bearer = _session_bearer(
            client, base_headers=invoke_headers, boto_session=boto_session
        )
        user_headers = {**invoke_headers, "Authorization": f"Bearer {bearer}"}

        health = client.get("/health")
        if health.status_code != 200:
            return SmokeRunResult(
                status="fail",
                checks=checks,
                error=f"health {health.status_code} {health.text[:200]}",
            )
        reported = health.json().get("environment")
        if reported != resolved_environment:
            return SmokeRunResult(
                status="fail",
                checks=checks,
                error=f"health environment {reported!r} != {resolved_environment!r}",
            )
        checks.append("health=1")

        bot_name = f"SmokeBot-{uuid4().hex[:8]}"
        bot_key = str(uuid4())
        bot_response = client.post(
            org_path(resolved_tenant, "/bots"),
            json={"name": bot_name},
            headers={**user_headers, "Idempotency-Key": bot_key},
        )
        if bot_response.status_code >= 400:
            return SmokeRunResult(
                status="fail",
                checks=checks,
                error=(
                    f"bot_create {bot_response.status_code} "
                    f"{bot_response.text[:300]}"
                ),
            )
        retry_bot = client.post(
            org_path(resolved_tenant, "/bots"),
            json={"name": bot_name},
            headers={**user_headers, "Idempotency-Key": bot_key},
        )
        if (
            retry_bot.status_code >= 400
            or bot_response.json()["bot_id"] != retry_bot.json()["bot_id"]
        ):
            return SmokeRunResult(
                status="fail", checks=checks, error="bot_idempotent failed"
            )
        checks.append("bot_idempotent=1")
        bot_id = bot_response.json()["bot_id"]

        channel_key = str(uuid4())
        channel_body = {"user_id": resolved_user, "bot_ids": [bot_id]}
        first_channel = client.post(
            org_path(resolved_tenant, "/channels"),
            json=channel_body,
            headers={**user_headers, "Idempotency-Key": channel_key},
        )
        second_channel = client.post(
            org_path(resolved_tenant, "/channels"),
            json=channel_body,
            headers={**user_headers, "Idempotency-Key": channel_key},
        )
        if first_channel.status_code >= 400 or second_channel.status_code >= 400:
            return SmokeRunResult(
                status="fail", checks=checks, error="channel_idempotent failed"
            )
        if first_channel.json()["channel_id"] != second_channel.json()["channel_id"]:
            return SmokeRunResult(
                status="fail", checks=checks, error="channel_idempotent dup"
            )
        checks.append("channel_idempotent=1")
        channel_id = first_channel.json()["channel_id"]

        fence_posted = client.post(
            org_path(resolved_tenant, f"/channels/{channel_id}/messages"),
            json={
                "author_kind": ActorKind.HUMAN,
                "author_id": resolved_user,
                "body": "Worker spot-check probe.",
                "addressed_to_bot_id": bot_id,
                "enqueue_turn": False,
            },
            headers=user_headers,
        )
        if fence_posted.status_code >= 400:
            return SmokeRunResult(
                status="fail",
                checks=checks,
                error=(
                    f"fence_post {fence_posted.status_code} "
                    f"{fence_posted.text[:300]}"
                ),
            )
        fence_turn_id = fence_posted.json()["turn_id"]
        worker_headers = register_worker_bearer(
            client,
            resolved_tenant,
            "integration-smoke-worker",
            base_headers=invoke_headers,
        )
        claim = client.post(
            org_path(resolved_tenant, f"/turns/{fence_turn_id}/claim"),
            json={"worker_id": "integration-smoke-worker"},
            headers=worker_headers,
        )
        if claim.status_code != 200 or not claim.json().get("acquired"):
            return SmokeRunResult(
                status="fail",
                checks=checks,
                error=f"worker_claim {claim.status_code} {claim.text[:300]}",
            )
        fence_token = claim.json()["fence_token"]
        complete = client.post(
            org_path(resolved_tenant, f"/turns/{fence_turn_id}/chunks"),
            json={"token": "done", "complete": True, "fence_token": fence_token},
            headers=worker_headers,
        )
        if complete.status_code >= 400:
            return SmokeRunResult(
                status="fail",
                checks=checks,
                error=f"worker_complete {complete.status_code} {complete.text[:300]}",
            )
        checks.append("worker_spot_check=1")

        posted = client.post(
            org_path(resolved_tenant, f"/channels/{channel_id}/messages"),
            json={
                "author_kind": ActorKind.HUMAN,
                "author_id": resolved_user,
                "body": "Reply with exactly: INTEGRATION-SMOKE-OK.",
                "addressed_to_bot_id": bot_id,
            },
            headers=user_headers,
        )
        if posted.status_code >= 400:
            return SmokeRunResult(
                status="fail",
                checks=checks,
                error=f"greeting_post {posted.status_code} {posted.text[:300]}",
            )
        turn_id = posted.json()["turn_id"]
        events: list[dict] = []
        with client.stream(
            "GET",
            org_path(resolved_tenant, f"/turns/{turn_id}/stream"),
            headers=user_headers,
        ) as stream:
            stream.raise_for_status()
            buffer = ""
            deadline = time.time() + 90
            for chunk in stream.iter_bytes():
                buffer += chunk.decode()
                parsed, buffer = parse_sse_frames(buffer)
                events.extend(parsed)
                if any(event.get("kind") == "turn.completed" for event in events):
                    break
                if time.time() > deadline:
                    break
        if not any(event.get("kind") == "turn.completed" for event in events):
            return SmokeRunResult(
                status="fail",
                checks=checks,
                error="turn did not reach turn.completed within 90s",
            )
        checks.append("turn_completed=1")

        listed = client.get(
            org_path(resolved_tenant, f"/channels/{channel_id}/messages"),
            headers=user_headers,
        )
        if listed.status_code != 200:
            return SmokeRunResult(
                status="fail",
                checks=checks,
                error=f"messages_list {listed.status_code} {listed.text[:300]}",
            )
        bot_messages = [
            message
            for message in listed.json().get("messages", [])
            if message.get("author_kind") == ActorKind.BOT
        ]
        if not bot_messages:
            return SmokeRunResult(status="fail", checks=checks, error="no bot reply")
        checks.append("bot_reply=1")

    return SmokeRunResult(status="pass", checks=checks)
