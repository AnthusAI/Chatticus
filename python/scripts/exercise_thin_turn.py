"""Exercise a deployed Chatticus thin turn through the CloudFront front door."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from uuid import uuid4

import httpx

from chatticus.cloud_environments import (
    CLOUD_ENVIRONMENTS,
    parse_cloud_environment,
    resolve_invoke_key_for_environment,
    resolve_thin_turn_base_url,
    thin_turn_stack_output,
)
from chatticus.http.worker_auth import register_worker_bearer
from chatticus.models import ActorKind
from chatticus.http.paths import org_path
from typing import Any


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

    def put(self, path: str, **kwargs: Any) -> httpx.Response:
        return self._client.put(f"{self._prefix}{path}", **kwargs)

    def stream(self, method: str, path: str, **kwargs: Any) -> Any:
        return self._client.stream(method, f"{self._prefix}{path}", **kwargs)

    def __enter__(self) -> "SameOriginApiClient":
        self._client.__enter__()
        return self

    def __exit__(self, *args: Any) -> None:
        self._client.__exit__(*args)


def _user_route_headers(base_headers: dict[str, str]) -> dict[str, str]:
    """Return headers for org user routes, optionally with CHATTICUS_LIVE_ID_TOKEN."""
    merged = dict(base_headers)
    id_token = os.environ.get("CHATTICUS_LIVE_ID_TOKEN", "").strip()
    if id_token:
        merged["Authorization"] = f"Bearer {id_token}"
    return merged


def _register_worker_headers(
    client: SameOriginApiClient,
    tenant_id: str,
    worker_id: str,
    headers: dict[str, str],
) -> dict[str, str]:
    """Register one worker and return request headers with its bearer credential."""
    return register_worker_bearer(
        client, tenant_id, worker_id, base_headers=headers
    )


def _invoke_key_for_environment(environment: str) -> str:
    """Read the front-door invoke key from the named stack secret."""
    return resolve_invoke_key_for_environment(parse_cloud_environment(environment))


def _frames(buffer: str) -> tuple[list[dict], str]:
    events: list[dict] = []
    while "\n\n" in buffer:
        frame, buffer = buffer.split("\n\n", 1)
        for line in frame.split("\n"):
            if line.startswith("data:"):
                events.append(json.loads(line[5:].strip()))
    return events, buffer


def _sqs_client():
    import boto3

    region = (
        os.environ.get("AWS_REGION")
        or os.environ.get("AWS_DEFAULT_REGION")
        or "us-east-1"
    )
    return boto3.client("sqs", region_name=region)


def _sqs_receive_one(queue_url: str, *, wait_seconds: int) -> dict | None:
    response = _sqs_client().receive_message(
        QueueUrl=queue_url,
        MaxNumberOfMessages=1,
        WaitTimeSeconds=wait_seconds,
        VisibilityTimeout=30,
    )
    messages = response.get("Messages") or []
    if not messages:
        return None
    return messages[0]


def _sqs_delete(queue_url: str, receipt_handle: str) -> None:
    _sqs_client().delete_message(QueueUrl=queue_url, ReceiptHandle=receipt_handle)


def _computer_continuation_matches(body: dict, *, job_id: str, turn_id: str) -> bool:
    """Return True when an SQS body is this exercise's computer continuation."""
    return (
        body.get("job_id") == job_id
        and body.get("turn_id") == turn_id
        and "computer" in (body.get("required_capabilities") or [])
    )


def _should_reconnect_first_stream(dropped_mid_stream: bool) -> bool:
    """Reconnect only after an intentional mid-token drop (178a1f)."""
    return dropped_mid_stream


def _streamed_body_matches_completed(events: list[dict]) -> bool:
    """Return True when turn.completed body equals joined turn.token text."""
    tokens = "".join(
        str(event["token"])
        for event in events
        if event.get("kind") == "turn.token" and event.get("token") is not None
    )
    completed = [event for event in events if event.get("kind") == "turn.completed"]
    if not completed:
        return False
    return completed[-1].get("body") == tokens


def _tool_result_bodies(events: list[dict]) -> list[str]:
    """Return durable journal bodies for tool.result events."""
    bodies: list[str] = []
    for event in events:
        if event.get("kind") != "tool.result":
            continue
        body = event.get("body")
        if isinstance(body, str) and body:
            bodies.append(body)
    return bodies


def _chromium_host_tool_result_body(events: list[dict]) -> str | None:
    """Return the first tool.result body from ChromiumActionExecutor on the host."""
    for body in _tool_result_bodies(events):
        if body.startswith("opened:"):
            return body
    return None


def _http_detail(response: httpx.Response) -> str:
    """Return a FastAPI or API-gateway error detail string when present."""
    try:
        body = response.json()
    except json.JSONDecodeError:
        return ""
    detail = body.get("detail")
    if detail is not None:
        return str(detail)
    message = body.get("message")
    if message is not None:
        return str(message)
    return ""


def _task_http_routes_absent(response: httpx.Response) -> bool:
    """True when the deployed stack has no task list/create/read handlers."""
    if response.status_code not in (404, 405):
        return False
    detail = _http_detail(response)
    return detail in ("Not Found", "")


def _task_http_required(environment: str | None) -> bool:
    """Fail instead of skip when task routes are expected on the named stack."""
    if os.environ.get("CHATTICUS_TASK_HTTP_REQUIRED", "").strip() == "1":
        return True
    return (
        environment == "development"
        and os.environ.get("CHATTICUS_DEVELOPMENT_TASK_HTTP_LIVE", "").strip() == "1"
    )


def _grant_http_routes_absent(response: httpx.Response) -> bool:
    """True when the deployed stack has no grant or gated-read handlers."""
    if response.status_code not in (404, 405):
        return False
    detail = _http_detail(response)
    return detail in ("Not Found", "")


def _grant_http_required(environment: str | None) -> bool:
    """Fail instead of skip when grant routes are expected on development."""
    if os.environ.get("CHATTICUS_GRANT_HTTP_REQUIRED", "").strip() == "1":
        return True
    return (
        environment == "development"
        and os.environ.get("CHATTICUS_DEVELOPMENT_GRANT_LIVE", "").strip() == "1"
    )


_RESEARCH_GRANT_BODY = {
    "tools": ["browse", "read_workspace"],
    "origins": ["https://docs.example.com"],
    "recipients": [],
    "file_scopes": ["/workspace/research"],
    "egress_classes": ["approved_origin_fetch"],
}


def _exercise_capability_grant_persistence(
    *,
    base_url: str,
    headers: dict[str, str],
    tenant_id: str,
    turn_id: str,
    user_id: str,
    environment: str | None,
) -> int:
    """Exercise durable grants and gated workspace reads on a named stack."""
    probe = SameOriginApiClient(base_url, headers=headers, timeout=60.0)
    try:
        worker_headers = _register_worker_headers(
            probe, tenant_id, "exercise-grant-worker", dict(headers)
        )
        missing = probe.put(
            org_path(tenant_id, f"/turns/{turn_id}/grant"),
            json=_RESEARCH_GRANT_BODY,
            headers=worker_headers,
        )
        if _grant_http_routes_absent(missing):
            if _grant_http_required(environment):
                print(
                    "capability_grant_persistence_required routes_missing "
                    f"{missing.status_code} {missing.text[:300]}",
                    file=sys.stderr,
                )
                return 1
            print("capability_grant_persistence_skip=1")
            return 0
        if missing.status_code != 200:
            print(
                f"capability_grant_persistence_grant "
                f"{missing.status_code} {missing.text[:300]}",
                file=sys.stderr,
            )
            return 1
        forbidden = probe.post(
            org_path(tenant_id, f"/turns/{turn_id}/workspace/read"),
            json={
                "user_id": user_id,
                "path": "/workspace/secrets/notes.txt",
            },
            headers=worker_headers,
        )
        if forbidden.status_code != 403:
            print(
                "capability_grant_persistence_forbidden "
                f"{forbidden.status_code} {forbidden.text[:300]}",
                file=sys.stderr,
            )
            return 1
        detail = _http_detail(forbidden)
        if "session" in detail.lower():
            print(
                f"capability_grant_persistence_forbidden_detail={detail!r}",
                file=sys.stderr,
            )
            return 1
        print("capability_grant_persistence_forbidden=403")
    finally:
        probe._client.close()
    recycled = SameOriginApiClient(base_url, headers=headers, timeout=60.0)
    try:
        worker_headers = _register_worker_headers(
            recycled, tenant_id, "exercise-grant-worker", dict(headers)
        )
        allowed = recycled.post(
            org_path(tenant_id, f"/turns/{turn_id}/workspace/read"),
            json={
                "user_id": user_id,
                "path": "/workspace/research/notes.txt",
            },
            headers=worker_headers,
        )
        if allowed.status_code != 200:
            print(
                "capability_grant_persistence_allowed "
                f"{allowed.status_code} {allowed.text[:300]}",
                file=sys.stderr,
            )
            return 1
        print("capability_grant_persistence_allowed=200")
        print("capability_grant_persistence=1")
        return 0
    finally:
        recycled._client.close()


def _exercise_named_task_http(
    client: SameOriginApiClient,
    *,
    bot_id: str,
    user_id: str,
    tenant_id: str,
    headers: dict[str, str],
    environment: str | None,
) -> int:
    """Exercise live task HTTP create, list, and read. Return 0 on pass or skip."""
    listed = client.get(org_path(tenant_id, f"/users/{user_id}/tasks"), headers=headers)
    if _task_http_routes_absent(listed):
        if _task_http_required(environment):
            print(
                "task_http_required routes_missing "
                f"{listed.status_code} {listed.text[:300]}",
                file=sys.stderr,
            )
            return 1
        print("task_http_skip=1")
        return 0
    if listed.status_code != 200:
        print(
            f"tasks_list_probe {listed.status_code} {listed.text[:300]}",
            file=sys.stderr,
        )
        return 1
    task_title = f"Exercise-{uuid4().hex[:8]}"
    task_worker_headers = _register_worker_headers(
        client, tenant_id, "exercise-task-worker", dict(headers)
    )
    created = client.post(
        org_path(tenant_id, f"/bots/{bot_id}/tasks/tool"),
        json={
            "user_id": user_id,
            "action": "create",
            "arguments": {"title": task_title},
        },
        headers=task_worker_headers,
    )
    if created.status_code != 200:
        print(
            f"task_create {created.status_code} {created.text[:300]}",
            file=sys.stderr,
        )
        return 1
    payload = created.json()
    task_id = payload.get("task_id")
    if not task_id or payload.get("status") != "open":
        print(f"task_create payload={payload!r}", file=sys.stderr)
        return 1
    if payload.get("created_by_bot_id") != bot_id:
        print(
            "task_create bot=" f"{payload.get('created_by_bot_id')!r} != {bot_id!r}",
            file=sys.stderr,
        )
        return 1
    print(f"task_create=1 task_id={task_id}")
    listed_after = client.get(
        org_path(tenant_id, f"/users/{user_id}/tasks"), headers=headers
    )
    if listed_after.status_code != 200:
        print(
            f"tasks_list {listed_after.status_code} {listed_after.text[:300]}",
            file=sys.stderr,
        )
        return 1
    listed_tasks = listed_after.json().get("tasks") or []
    listed_ids = [row.get("task_id") for row in listed_tasks]
    if task_id not in listed_ids:
        print(
            f"tasks_list missing {task_id!r} in {listed_ids!r}",
            file=sys.stderr,
        )
        return 1
    listed_row = next(row for row in listed_tasks if row.get("task_id") == task_id)
    if listed_row.get("title") != task_title:
        print(
            f"tasks_list title={listed_row.get('title')!r} != {task_title!r}",
            file=sys.stderr,
        )
        return 1
    print("tasks_list=1")
    fetched = client.get(org_path(tenant_id, f"/tasks/{task_id}"), headers=headers)
    if fetched.status_code != 200:
        print(
            f"task_get {fetched.status_code} {fetched.text[:300]}",
            file=sys.stderr,
        )
        return 1
    fetched_payload = fetched.json()
    if fetched_payload.get("task_id") != task_id:
        print(
            "task_get task_id=" f"{fetched_payload.get('task_id')!r} != {task_id!r}",
            file=sys.stderr,
        )
        return 1
    if fetched_payload.get("title") != task_title:
        print(
            f"task_get title={fetched_payload.get('title')!r} != {task_title!r}",
            file=sys.stderr,
        )
        return 1
    print("task_get=1")
    other_tenant = f"{tenant_id}-isolation-exercise"
    other_listed = client.get(
        org_path(other_tenant, f"/users/{user_id}/tasks"),
        headers=headers,
    )
    if other_listed.status_code != 200:
        print(
            "task_tenant_list " f"{other_listed.status_code} {other_listed.text[:300]}",
            file=sys.stderr,
        )
        return 1
    if other_listed.json().get("tasks"):
        print(
            "task_tenant_list expected empty "
            f"got {other_listed.json().get('tasks')!r}",
            file=sys.stderr,
        )
        return 1
    other_get = client.get(
        org_path(other_tenant, f"/tasks/{task_id}"),
        headers=headers,
    )
    if other_get.status_code != 404:
        print(
            "task_tenant_get " f"{other_get.status_code} {other_get.text[:300]}",
            file=sys.stderr,
        )
        return 1
    print("task_tenant_isolation=1")
    return 0


def _sqs_receive_computer_continuation(
    queue_url: str,
    *,
    job_id: str,
    turn_id: str,
    wait_seconds: int,
) -> dict | None:
    """Receive until the matching computer job appears, deleting leftovers."""
    deadline = time.monotonic() + wait_seconds
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None
        message = _sqs_receive_one(
            queue_url, wait_seconds=max(1, min(20, int(remaining)))
        )
        if message is None:
            continue
        body = json.loads(message["Body"])
        _sqs_delete(queue_url, message["ReceiptHandle"])
        if _computer_continuation_matches(body, job_id=job_id, turn_id=turn_id):
            return body
        print(
            "computer_queue_stale "
            f"turn_id={body.get('turn_id')!r} job_id={body.get('job_id')!r}",
            file=sys.stderr,
        )


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(line_buffering=True)
        sys.stderr.reconfigure(line_buffering=True)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--environment",
        choices=CLOUD_ENVIRONMENTS,
        help=(
            "Named cloud environment. Resolves CloudFront via env, SSM, "
            "or CloudFormation."
        ),
    )
    parser.add_argument(
        "--base-url",
        default="",
        help="CloudFront origin, https://... Overrides --environment lookup when set.",
    )
    parser.add_argument("--tenant-id", default="anthus")
    parser.add_argument("--user-id", default="ryan")
    parser.add_argument("--invoke-key", default="")
    args = parser.parse_args()
    if not args.environment and not args.base_url:
        print("pass --environment or --base-url", file=sys.stderr)
        return 2
    try:
        environment = (
            parse_cloud_environment(args.environment) if args.environment else None
        )
        base_url = resolve_thin_turn_base_url(
            environment or "development",
            base_url=args.base_url or None,
        )
    except (LookupError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 2
    if args.environment:
        print(f"environment={args.environment} base_url={base_url}")
    headers: dict[str, str] = {}
    invoke_key = args.invoke_key
    if not invoke_key and environment is not None:
        invoke_key = _invoke_key_for_environment(environment)
    if invoke_key:
        headers["X-Chatticus-Invoke-Key"] = invoke_key
    user_headers = _user_route_headers(headers)
    with SameOriginApiClient(base_url, headers=user_headers, timeout=900.0) as client:
        health = client.get("/health")
        if health.status_code != 200:
            print(f"health {health.status_code} {health.text[:200]}", file=sys.stderr)
            return 1
        reported_environment = health.json().get("environment")
        expected_environment = environment or "development"
        if (
            reported_environment is not None
            and reported_environment != expected_environment
        ):
            print(
                "health_environment "
                f"{reported_environment!r} != {expected_environment!r}",
                file=sys.stderr,
            )
            return 1
        if reported_environment == expected_environment:
            print("health_environment=1")
        missing_headers = _register_worker_headers(
            client,
            args.tenant_id,
            "exercise-missing",
            dict(headers),
        )
        missing = client.post(
            org_path(args.tenant_id, "/turns/missing-turn-id/claim"),
            json={"worker_id": "exercise-missing"},
            headers=missing_headers,
        )
        if missing.status_code != 404:
            print(
                f"missing_claim {missing.status_code} {missing.text[:300]}",
                file=sys.stderr,
            )
            return 1
        print("missing_claim=404")
        bot_name = f"ExerciseBot-{uuid4().hex[:8]}"
        bot_key = str(uuid4())
        bot_response = client.post(
            org_path(args.tenant_id, "/bots"),
            json={"user_id": args.user_id, "name": bot_name},
            headers={"Idempotency-Key": bot_key},
        )
        if bot_response.status_code >= 400:
            print(
                f"bots {bot_response.status_code} {bot_response.text[:300]}",
                file=sys.stderr,
            )
            return 1
        retry_bot = client.post(
            org_path(args.tenant_id, "/bots"),
            json={"user_id": args.user_id, "name": bot_name},
            headers={"Idempotency-Key": bot_key},
        )
        if retry_bot.status_code >= 400:
            print(
                f"bot_idempotent {retry_bot.status_code} {retry_bot.text[:300]}",
                file=sys.stderr,
            )
            return 1
        bot = bot_response.json()
        if bot["bot_id"] != retry_bot.json()["bot_id"]:
            print(
                "bot_idempotent duplicated "
                f"{bot['bot_id']} {retry_bot.json()['bot_id']}",
                file=sys.stderr,
            )
            return 1
        print("bot_idempotent=1")
        duplicate_bot = client.post(
            org_path(args.tenant_id, "/bots"),
            json={"user_id": args.user_id, "name": bot["name"]},
        )
        if duplicate_bot.status_code != 400:
            print(
                f"bot_name_dup {duplicate_bot.status_code} {duplicate_bot.text[:300]}",
                file=sys.stderr,
            )
            return 1
        print("bot_name_dup=1")
        looked_up = client.get(
            org_path(args.tenant_id, "/bots"),
            params={"user_id": args.user_id, "name": bot["name"]},
        )
        if (
            looked_up.status_code != 200
            or looked_up.json().get("bot_id") != bot["bot_id"]
        ):
            print(
                f"bot_by_name {looked_up.status_code} {looked_up.text[:300]}",
                file=sys.stderr,
            )
            return 1
        print("bot_by_name=1")
        listed_bots = client.get(org_path(args.tenant_id, f"/users/{args.user_id}/bots"))
        listed_ids = [
            row.get("bot_id") for row in (listed_bots.json().get("bots") or [])
        ]
        if listed_bots.status_code != 200 or bot["bot_id"] not in listed_ids:
            print(
                f"bots_list {listed_bots.status_code} {listed_bots.text[:300]}",
                file=sys.stderr,
            )
            return 1
        print("bots_list=1")
        if args.environment:
            task_result = _exercise_named_task_http(
                client,
                bot_id=bot["bot_id"],
                user_id=args.user_id,
                tenant_id=args.tenant_id,
                headers=dict(user_headers),
                environment=environment,
            )
            if task_result != 0:
                return task_result
        remembered = client.post(
            org_path(args.tenant_id, f"/bots/{bot['bot_id']}/memory"),
            json={"key": "voice", "value": "short and direct"},
        )
        if remembered.status_code != 200:
            print(
                f"bot_memory {remembered.status_code} {remembered.text[:300]}",
                file=sys.stderr,
            )
            return 1
        fetched = client.get(org_path(args.tenant_id, f"/bots/{bot['bot_id']}"))
        if fetched.status_code != 200:
            print(
                f"bot_get {fetched.status_code} {fetched.text[:300]}",
                file=sys.stderr,
            )
            return 1
        memory = fetched.json().get("memory") or {}
        if memory.get("voice") != "short and direct":
            print(f"bot_memory roundtrip failed {memory!r}", file=sys.stderr)
            return 1
        print("bot_memory=voice")
        client.post(
            org_path(args.tenant_id, "/computers/stopped"),
            json={"user_id": args.user_id, "stopped": True},
        )
        computer = client.get(org_path(args.tenant_id, f"/users/{args.user_id}/computer"))
        if (
            computer.status_code != 200
            or computer.json().get("stopped") is not True
            or not computer.json().get("computer_id")
        ):
            print(
                f"computer_get {computer.status_code} {computer.text[:300]}",
                file=sys.stderr,
            )
            return 1
        print("computer_get=1")
        channel_key = str(uuid4())
        channel_body = {"user_id": args.user_id, "bot_ids": [bot["bot_id"]]}
        first_channel = client.post(
            org_path(args.tenant_id, "/channels"),
            json=channel_body,
            headers={"Idempotency-Key": channel_key},
        )
        second_channel = client.post(
            org_path(args.tenant_id, "/channels"),
            json=channel_body,
            headers={"Idempotency-Key": channel_key},
        )
        if first_channel.status_code >= 400 or second_channel.status_code >= 400:
            print(
                "channel_idempotent failed "
                f"{first_channel.status_code} {second_channel.status_code} "
                f"{first_channel.text[:200]} {second_channel.text[:200]}",
                file=sys.stderr,
            )
            return 1
        channel = first_channel.json()
        if channel["channel_id"] != second_channel.json()["channel_id"]:
            print(
                "channel_idempotent duplicated "
                f"{channel['channel_id']} {second_channel.json()['channel_id']}",
                file=sys.stderr,
            )
            return 1
        print("channel_idempotent=1")
        channel_get = client.get(org_path(args.tenant_id, f"/channels/{channel['channel_id']}"))
        if channel_get.status_code != 200:
            print(
                f"channel_get {channel_get.status_code} {channel_get.text[:300]}",
                file=sys.stderr,
            )
            return 1
        if channel_get.json().get("channel_id") != channel["channel_id"]:
            print(
                "channel_get roundtrip failed "
                f"{channel_get.json().get('channel_id')} != {channel['channel_id']}",
                file=sys.stderr,
            )
            return 1
        print("channel_get=1")
        listed_channels = client.get(org_path(args.tenant_id, f"/users/{args.user_id}/channels"))
        if listed_channels.status_code != 200:
            print(
                "channels_list "
                f"{listed_channels.status_code} {listed_channels.text[:300]}",
                file=sys.stderr,
            )
            return 1
        channel_ids = {
            row["channel_id"] for row in listed_channels.json().get("channels", [])
        }
        if channel["channel_id"] not in channel_ids:
            print(
                f"channels_list missing {channel['channel_id']} in {channel_ids!r}",
                file=sys.stderr,
            )
            return 1
        print("channels_list=1")
        fence_posted = client.post(
            org_path(args.tenant_id, f"/channels/{channel['channel_id']}/messages"),
            json={
                "author_kind": ActorKind.HUMAN,
                "author_id": args.user_id,
                "body": "Fence probe; do not wait on this turn.",
                "addressed_to_bot_id": bot["bot_id"],
                "enqueue_turn": False,
            },
        ).json()
        fence_turn_id = fence_posted["turn_id"]
        channel_turn = client.get(org_path(args.tenant_id, f"/channels/{channel['channel_id']}/turn"))
        if (
            channel_turn.status_code != 200
            or channel_turn.json().get("turn_id") != fence_turn_id
        ):
            print(
                f"channel_turn {channel_turn.status_code} {channel_turn.text[:300]}",
                file=sys.stderr,
            )
            return 1
        print("channel_turn=1")
        listed_turns = client.get(org_path(args.tenant_id, f"/users/{args.user_id}/turns"))
        listed_turn_ids = [
            row.get("turn_id") for row in (listed_turns.json().get("turns") or [])
        ]
        if listed_turns.status_code != 200 or fence_turn_id not in listed_turn_ids:
            print(
                f"turns_list {listed_turns.status_code} {listed_turns.text[:300]}",
                file=sys.stderr,
            )
            return 1
        print("turns_list=1")
        if args.environment:
            grant_result = _exercise_capability_grant_persistence(
                base_url=base_url,
                headers=dict(user_headers),
                tenant_id=args.tenant_id,
                turn_id=fence_turn_id,
                user_id=args.user_id,
                environment=environment,
            )
            if grant_result != 0:
                return grant_result
        claim_a_headers = _register_worker_headers(
            client, args.tenant_id, "exercise-fence-a", dict(headers)
        )
        claim_b_headers = _register_worker_headers(
            client, args.tenant_id, "exercise-fence-b", dict(headers)
        )
        claim_a = client.post(
            org_path(args.tenant_id, f"/turns/{fence_turn_id}/claim"),
            json={"worker_id": "exercise-fence-a"},
            headers=claim_a_headers,
        )
        claim_b = client.post(
            org_path(args.tenant_id, f"/turns/{fence_turn_id}/claim"),
            json={"worker_id": "exercise-fence-b"},
            headers=claim_b_headers,
        )
        print(
            f"fence_turn_id={fence_turn_id} "
            f"claim_a={claim_a.status_code} claim_b={claim_b.status_code}"
        )
        acquired = claim_a.status_code == 200 and claim_a.json().get("acquired") is True
        if not acquired:
            print(
                "fence claim did not acquire "
                f"claim_a={claim_a.status_code} {claim_a.text[:300]}",
                file=sys.stderr,
            )
            return 1
        if claim_b.status_code != 409:
            print(
                "second claim did not get 409 while the lease was held",
                file=sys.stderr,
            )
            return 1
        idem_key = str(uuid4())
        idem_body = {
            "author_kind": ActorKind.HUMAN,
            "author_id": args.user_id,
            "body": "Idempotent post; do not enqueue.",
            "addressed_to_bot_id": bot["bot_id"],
            "enqueue_turn": False,
        }
        first_idem = client.post(
            org_path(args.tenant_id, f"/channels/{channel['channel_id']}/messages"),
            json=idem_body,
            headers={"Idempotency-Key": idem_key},
        )
        second_idem = client.post(
            org_path(args.tenant_id, f"/channels/{channel['channel_id']}/messages"),
            json=idem_body,
            headers={"Idempotency-Key": idem_key},
        )
        if first_idem.status_code >= 400 or second_idem.status_code >= 400:
            print(
                "post_idempotent failed "
                f"{first_idem.status_code} {second_idem.status_code} "
                f"{first_idem.text[:200]} {second_idem.text[:200]}",
                file=sys.stderr,
            )
            return 1
        first_message = first_idem.json()["message"]
        second_message = second_idem.json()["message"]
        listed = client.get(org_path(args.tenant_id, f"/channels/{channel['channel_id']}/messages"))
        if listed.status_code != 200:
            print(
                f"list_messages {listed.status_code} {listed.text[:300]}",
                file=sys.stderr,
            )
            return 1
        message_ids = [item["message_id"] for item in listed.json()["messages"]]
        if (
            first_message["message_id"] != second_message["message_id"]
            or first_idem.json()["turn_id"] != second_idem.json()["turn_id"]
            or message_ids.count(first_message["message_id"]) != 1
            or len(message_ids) != 2
        ):
            print(
                "post_idempotent duplicated "
                f"first={first_message['message_id']} "
                f"second={second_message['message_id']} "
                f"count={len(message_ids)}",
                file=sys.stderr,
            )
            return 1
        print("post_idempotent=1")
        if acquired:
            fence_token = claim_a.json()["fence_token"]
            draft = client.post(
                org_path(args.tenant_id, f"/turns/{fence_turn_id}/chunks"),
                json={
                    "token": "Here is a draft.",
                    "complete": False,
                    "fence_token": fence_token,
                },
                headers=claim_a_headers,
            )
            if draft.status_code >= 400:
                print(
                    f"waiting_draft {draft.status_code} {draft.text[:300]}",
                    file=sys.stderr,
                )
                return 1
            waiting = client.post(
                org_path(args.tenant_id, f"/turns/{fence_turn_id}/waiting"),
                json={"gate": "browser", "fence_token": fence_token},
                headers=claim_a_headers,
            )
            if waiting.status_code >= 400:
                print(
                    f"waiting_post {waiting.status_code} {waiting.text[:300]}",
                    file=sys.stderr,
                )
                return 1
            turn_read = client.get(org_path(args.tenant_id, f"/turns/{fence_turn_id}"))
            if turn_read.status_code != 200:
                print(
                    f"turn_read {turn_read.status_code} {turn_read.text[:300]}",
                    file=sys.stderr,
                )
                return 1
            turn_payload = turn_read.json()
            if turn_payload.get("waiting_for") != "browser":
                print(
                    f"turn_waiting_for={turn_payload.get('waiting_for')!r}",
                    file=sys.stderr,
                )
                return 1
            print("turn_waiting_for=browser")
            channel_waiting = client.get(org_path(args.tenant_id, f"/channels/{channel['channel_id']}/turn"))
            if (
                channel_waiting.status_code != 200
                or channel_waiting.json().get("turn_id") != fence_turn_id
                or channel_waiting.json().get("waiting_for") != "browser"
            ):
                print(
                    "channel_turn_waiting "
                    f"{channel_waiting.status_code} {channel_waiting.text[:300]}",
                    file=sys.stderr,
                )
                return 1
            print("channel_turn_waiting=1")
            pending = turn_payload.get("pending_computer_tool") or {}
            if (
                pending.get("tool_name") != "request_computer_capability"
                or pending.get("arguments") != {"gate": "browser"}
                or not pending.get("action_id")
            ):
                print(f"pending_computer_tool={pending!r}", file=sys.stderr)
                return 1
            print("pending_computer_tool=request_computer_capability")
            waiting_kinds: list[str] = []
            waiting_events: list[dict] = []
            with client.stream("GET", org_path(args.tenant_id, f"/turns/{fence_turn_id}/stream")) as stream:
                stream.raise_for_status()
                buffer = ""
                deadline = time.time() + 30
                for chunk in stream.iter_bytes():
                    buffer += chunk.decode()
                    parsed, buffer = _frames(buffer)
                    waiting_events.extend(parsed)
                    waiting_kinds.extend(event.get("kind") for event in parsed)
                    if "turn.waiting" in waiting_kinds:
                        break
                    if time.time() > deadline:
                        break
            print(f"waiting_stream_kinds={waiting_kinds}")
            if "turn.waiting" not in waiting_kinds:
                print("fence turn did not emit turn.waiting", file=sys.stderr)
                return 1
            journal_waiting = [
                event for event in waiting_events if event.get("kind") == "turn.waiting"
            ]
            journal_pending = journal_waiting[0].get("pending_computer_tool") or {}
            if (
                journal_pending.get("tool_name") != "request_computer_capability"
                or journal_pending.get("arguments") != {"gate": "browser"}
                or journal_pending.get("action_id") != pending.get("action_id")
            ):
                print(
                    f"journal_pending_computer_tool={journal_pending!r}",
                    file=sys.stderr,
                )
                return 1
            print("journal_pending_computer_tool=request_computer_capability")
            stale_waiting = client.post(
                org_path(args.tenant_id, f"/turns/{fence_turn_id}/waiting"),
                json={"gate": "browser", "fence_token": fence_token},
                headers=claim_a_headers,
            )
            if stale_waiting.status_code != 409:
                print(
                    f"stale_waiting {stale_waiting.status_code} "
                    f"{stale_waiting.text[:300]}",
                    file=sys.stderr,
                )
                return 1
            print("stale_waiting=409")
            resume_stopped = client.post(
                org_path(args.tenant_id, f"/turns/{fence_turn_id}/resume"),
                headers=claim_a_headers,
            )
            if resume_stopped.status_code != 409:
                print(
                    f"resume_while_stopped {resume_stopped.status_code} "
                    f"{resume_stopped.text[:300]}",
                    file=sys.stderr,
                )
                return 1
            print("resume_while_stopped=409")
            finisher_headers = _register_worker_headers(
                client, args.tenant_id, "exercise-waiting-finisher", dict(headers)
            )
            finisher = client.post(
                org_path(args.tenant_id, f"/turns/{fence_turn_id}/claim"),
                json={"worker_id": "exercise-waiting-finisher"},
                headers=finisher_headers,
            )
            if finisher.status_code == 200 and finisher.json().get("acquired"):
                complete = client.post(
                    org_path(args.tenant_id, f"/turns/{fence_turn_id}/chunks"),
                    json={
                        "token": "",
                        "complete": True,
                        "fence_token": finisher.json()["fence_token"],
                    },
                    headers=finisher_headers,
                )
                if complete.status_code >= 400:
                    print(
                        f"waiting_complete {complete.status_code} "
                        f"{complete.text[:300]}",
                        file=sys.stderr,
                    )
                    return 1
        posted_response = client.post(
            org_path(args.tenant_id, f"/channels/{channel['channel_id']}/messages"),
            json={
                "author_kind": ActorKind.HUMAN,
                "author_id": args.user_id,
                "body": "Reply with three short sentences separated by periods.",
                "addressed_to_bot_id": bot["bot_id"],
            },
        )
        if posted_response.status_code >= 400:
            print(
                f"greeting {posted_response.status_code} "
                f"{posted_response.text[:300]}",
                file=sys.stderr,
            )
            return 1
        posted = posted_response.json()
        turn_id = posted["turn_id"]
        print(
            f"tenant_id={args.tenant_id} "
            f"channel_id={channel['channel_id']} turn_id={turn_id}"
        )
        events: list[dict] = []
        dropped_mid_stream = False
        with client.stream("GET", org_path(args.tenant_id, f"/turns/{turn_id}/stream")) as stream:
            stream.raise_for_status()
            buffer = ""
            deadline = time.time() + 90
            for chunk in stream.iter_bytes():
                buffer += chunk.decode()
                parsed, buffer = _frames(buffer)
                events.extend(parsed)
                kinds_so_far = [event.get("kind") for event in events]
                if (
                    "turn.started" in kinds_so_far
                    and "turn.token" in kinds_so_far
                    and "turn.completed" not in kinds_so_far
                ):
                    dropped_mid_stream = True
                    break
                terminal_kind = events[-1].get("kind")
                if terminal_kind in (
                    "turn.completed",
                    "turn.failed",
                    "turn.reconciling",
                ):
                    break
                if time.time() > deadline:
                    break
        kinds = [event.get("kind") for event in events]
        print(f"first_stream_kinds={kinds} dropped_mid_stream={dropped_mid_stream}")
        if not events:
            print("first stream delivered no events", file=sys.stderr)
            return 1
        resumed: list[dict] = []
        if _should_reconnect_first_stream(dropped_mid_stream):
            reconnect_after = events[-1]["seq"]
            print(f"reconnect_last_event_id={reconnect_after}")
            with client.stream(
                "GET",
                org_path(args.tenant_id, f"/turns/{turn_id}/stream"),
                headers={"Last-Event-ID": str(reconnect_after)},
            ) as stream:
                stream.raise_for_status()
                buffer = ""
                deadline = time.time() + 90
                for chunk in stream.iter_bytes():
                    buffer += chunk.decode()
                    parsed, buffer = _frames(buffer)
                    resumed.extend(parsed)
                    combined = events + resumed
                    if combined and combined[-1].get("kind") == "turn.completed":
                        break
                    if time.time() > deadline:
                        break
            print(f"resumed_stream_kinds={[event.get('kind') for event in resumed]}")
            if resumed and min(event["seq"] for event in resumed) <= reconnect_after:
                print(
                    f"reconnect replayed seq at or before Last-Event-ID={reconnect_after}",
                    file=sys.stderr,
                )
                return 1
        else:
            print("reconnect_skip=1")
        all_events = events + resumed
        seqs = [event["seq"] for event in all_events]
        if len(seqs) != len(set(seqs)):
            print(f"duplicate seqs across drop/reconnect: {seqs}", file=sys.stderr)
            return 1
        if seqs != sorted(seqs):
            print(f"out-of-order seqs: {seqs}", file=sys.stderr)
            return 1
        if not any(event.get("kind") == "turn.completed" for event in all_events):
            failed = [
                event for event in all_events if event.get("kind") == "turn.failed"
            ]
            if failed:
                print(
                    f"greeting_turn_failed body={failed[-1].get('body')!r}",
                    file=sys.stderr,
                )
            print("greeting did not reach turn.completed", file=sys.stderr)
            return 1
        stopped_response = client.get(
            org_path(args.tenant_id, "/computers/stopped"),
            params={"user_id": args.user_id},
        )
        if stopped_response.status_code != 200:
            print(
                f"stopped {stopped_response.status_code} {stopped_response.text[:300]}",
                file=sys.stderr,
            )
            return 1
        stopped = stopped_response.json()
        listed = client.get(org_path(args.tenant_id, f"/channels/{channel['channel_id']}/messages"))
        if listed.status_code != 200:
            print(f"messages {listed.status_code} {listed.text[:300]}", file=sys.stderr)
            return 1
        messages = listed.json()["messages"]
        bot_messages = [m for m in messages if m["author_kind"] == ActorKind.BOT]
        print(f"computer_stopped={stopped['stopped']} bot_messages={len(bot_messages)}")
        if not stopped["stopped"] or not bot_messages:
            return 1
        channel_turn_done = client.get(org_path(args.tenant_id, f"/channels/{channel['channel_id']}/turn"))
        if channel_turn_done.status_code != 404:
            print(
                f"channel_turn_done {channel_turn_done.status_code} "
                f"{channel_turn_done.text[:300]}",
                file=sys.stderr,
            )
            return 1
        print("channel_turn_done=1")
        after = messages[0]["seq"]
        listed_after = client.get(
            org_path(args.tenant_id, f"/channels/{channel['channel_id']}/messages"),
            params={"after": after},
        )
        if listed_after.status_code != 200:
            print(
                f"messages_after {listed_after.status_code} "
                f"{listed_after.text[:300]}",
                file=sys.stderr,
            )
            return 1
        after_messages = listed_after.json()["messages"]
        print(f"channel_after={after} remaining={len(after_messages)}")
        if any(item["seq"] <= after for item in after_messages):
            print("channel after replayed seq at or before after", file=sys.stderr)
            return 1
        if len(after_messages) != len(messages) - 1:
            print(
                f"channel after count {len(after_messages)} "
                f"expected {len(messages) - 1}",
                file=sys.stderr,
            )
            return 1
        first_turn_seq = all_events[0]["seq"]
        listed_turn_after = client.get(
            org_path(args.tenant_id, f"/turns/{turn_id}/events"),
            params={"after": first_turn_seq},
        )
        if listed_turn_after.status_code != 200:
            print(
                f"turn_events_after {listed_turn_after.status_code} "
                f"{listed_turn_after.text[:300]}",
                file=sys.stderr,
            )
            return 1
        turn_after_events = listed_turn_after.json()["events"]
        print(
            f"turn_after={first_turn_seq} remaining={len(turn_after_events)} "
            f"kinds={[event.get('kind') for event in turn_after_events]}"
        )
        if any(item["seq"] <= first_turn_seq for item in turn_after_events):
            print("turn events after replayed seq at or before after", file=sys.stderr)
            return 1
        if not turn_after_events:
            print("turn events after returned no rows", file=sys.stderr)
            return 1
        if turn_after_events[-1].get("kind") != "turn.completed":
            print(
                "turn events after did not end at turn.completed",
                file=sys.stderr,
            )
            return 1
        first_greeting_body = bot_messages[0]["body"]
        second_post = client.post(
            org_path(args.tenant_id, f"/channels/{channel['channel_id']}/messages"),
            json={
                "author_kind": ActorKind.HUMAN,
                "author_id": args.user_id,
                "body": "Reply with exactly: SECOND-TURN-MARKER.",
                "addressed_to_bot_id": bot["bot_id"],
            },
        )
        if second_post.status_code >= 400:
            print(
                f"second_turn_post {second_post.status_code} "
                f"{second_post.text[:300]}",
                file=sys.stderr,
            )
            return 1
        second_turn_id = second_post.json()["turn_id"]
        second_events: list[dict] = []
        with client.stream("GET", org_path(args.tenant_id, f"/turns/{second_turn_id}/stream")) as stream:
            stream.raise_for_status()
            buffer = ""
            deadline = time.time() + 90
            for chunk in stream.iter_bytes():
                buffer += chunk.decode()
                parsed, buffer = _frames(buffer)
                second_events.extend(parsed)
                if second_events and second_events[-1].get("kind") == "turn.completed":
                    break
                if time.time() > deadline:
                    break
        if not _streamed_body_matches_completed(second_events):
            completed = [
                event
                for event in second_events
                if event.get("kind") == "turn.completed"
            ]
            tokens = "".join(
                str(event["token"])
                for event in second_events
                if event.get("kind") == "turn.token" and event.get("token") is not None
            )
            body = completed[-1].get("body") if completed else None
            print(
                f"second_turn_body_mismatch streamed={tokens!r} completed={body!r}",
                file=sys.stderr,
            )
            return 1
        second_completed = [
            event for event in second_events if event.get("kind") == "turn.completed"
        ]
        if second_completed[-1].get("body") == first_greeting_body:
            print(
                "second_turn_completed_body reused first greeting "
                f"{first_greeting_body!r}",
                file=sys.stderr,
            )
            return 1
        print("second_turn_completed_body=1")
        browser_post = client.post(
            org_path(args.tenant_id, f"/channels/{channel['channel_id']}/messages"),
            json={
                "author_kind": ActorKind.HUMAN,
                "author_id": args.user_id,
                "body": "research this and open the household browser",
                "addressed_to_bot_id": bot["bot_id"],
            },
        )
        if browser_post.status_code >= 400:
            print(
                f"model_waiting_post {browser_post.status_code} "
                f"{browser_post.text[:300]}",
                file=sys.stderr,
            )
            return 1
        browser_turn_id = browser_post.json()["turn_id"]
        model_wait_kinds: list[str] = []
        model_wait_events: list[dict] = []
        with client.stream("GET", org_path(args.tenant_id, f"/turns/{browser_turn_id}/stream")) as stream:
            stream.raise_for_status()
            buffer = ""
            deadline = time.time() + 90
            for chunk in stream.iter_bytes():
                buffer += chunk.decode()
                parsed, buffer = _frames(buffer)
                model_wait_events.extend(parsed)
                model_wait_kinds.extend(event.get("kind") for event in parsed)
                if "turn.waiting" in model_wait_kinds:
                    break
                if "turn.completed" in model_wait_kinds:
                    break
                if time.time() > deadline:
                    break
        print(f"model_waiting_turn={browser_turn_id} kinds={model_wait_kinds}")
        if "turn.waiting" not in model_wait_kinds:
            print(
                "live model did not emit turn.waiting for a browser request",
                file=sys.stderr,
            )
            return 1
        model_turn_read = client.get(org_path(args.tenant_id, f"/turns/{browser_turn_id}"))
        if model_turn_read.status_code != 200:
            print(
                f"model_turn_read {model_turn_read.status_code} "
                f"{model_turn_read.text[:300]}",
                file=sys.stderr,
            )
            return 1
        if model_turn_read.json().get("waiting_for") != "browser":
            print(
                f"model_turn_waiting_for="
                f"{model_turn_read.json().get('waiting_for')!r}",
                file=sys.stderr,
            )
            return 1
        print("model_turn_waiting_for=browser")
        model_pending = model_turn_read.json().get("pending_computer_tool") or {}
        if (
            model_pending.get("tool_name") != "request_computer_capability"
            or model_pending.get("arguments") != {"gate": "browser"}
            or not model_pending.get("action_id")
        ):
            print(f"model_pending_computer_tool={model_pending!r}", file=sys.stderr)
            return 1
        print("model_pending_computer_tool=request_computer_capability")
        model_journal_waiting = [
            event for event in model_wait_events if event.get("kind") == "turn.waiting"
        ]
        model_journal_pending = (
            model_journal_waiting[0].get("pending_computer_tool") or {}
        )
        if (
            model_journal_pending.get("tool_name") != "request_computer_capability"
            or model_journal_pending.get("arguments") != {"gate": "browser"}
            or model_journal_pending.get("action_id") != model_pending.get("action_id")
        ):
            print(
                f"model_journal_pending_computer_tool={model_journal_pending!r}",
                file=sys.stderr,
            )
            return 1
        print("model_journal_pending_computer_tool=request_computer_capability")
        resume_headers = _register_worker_headers(
            client, args.tenant_id, "exercise-resume-worker", dict(headers)
        )
        model_resume = client.post(
            org_path(args.tenant_id, f"/turns/{browser_turn_id}/resume"),
            headers=resume_headers,
        )
        if model_resume.status_code != 409:
            print(
                f"model_resume_while_stopped {model_resume.status_code} "
                f"{model_resume.text[:300]}",
                file=sys.stderr,
            )
            return 1
        print("model_resume_while_stopped=409")
        if args.environment == "development":
            client.post(
                org_path(args.tenant_id, "/computers/stopped"),
                json={"user_id": args.user_id, "stopped": False},
            )
            resumed_running = client.post(
                org_path(args.tenant_id, f"/turns/{browser_turn_id}/resume"),
                headers=resume_headers,
            )
            if resumed_running.status_code != 200:
                print(
                    f"resume_while_running {resumed_running.status_code} "
                    f"{resumed_running.text[:300]}",
                    file=sys.stderr,
                )
                client.post(
                    org_path(args.tenant_id, "/computers/stopped"),
                    json={"user_id": args.user_id, "stopped": True},
                )
                return 1
            resume_payload = resumed_running.json()
            job_id = resume_payload.get("job_id")
            resume_caps = resume_payload.get("required_capabilities") or []
            if resume_caps != ["computer"]:
                print(
                    f"resume_required_capabilities={resume_caps!r}",
                    file=sys.stderr,
                )
                client.post(
                    org_path(args.tenant_id, "/computers/stopped"),
                    json={"user_id": args.user_id, "stopped": True},
                )
                return 1
            print("resume_required_capabilities=computer")
            if not job_id:
                print(f"resume_payload={resume_payload!r}", file=sys.stderr)
                client.post(
                    org_path(args.tenant_id, "/computers/stopped"),
                    json={"user_id": args.user_id, "stopped": True},
                )
                return 1
            generation = None
            deadline = time.monotonic() + 25
            while time.monotonic() < deadline:
                computer_after = client.get(org_path(args.tenant_id, f"/users/{args.user_id}/computer"))
                generation = computer_after.json().get("host_start_generation")
                if isinstance(generation, int) and generation >= 1:
                    break
                time.sleep(2)
            if not isinstance(generation, int) or generation < 1:
                print(
                    f"host_start_generation={generation!r}",
                    file=sys.stderr,
                )
                client.post(
                    org_path(args.tenant_id, "/computers/stopped"),
                    json={"user_id": args.user_id, "stopped": True},
                )
                return 1
            print(f"host_start_generation={generation}")
            try:
                computer_queue = thin_turn_stack_output(
                    environment or "development", "ComputerTurnQueueUrl"
                )
                cpu_queue = thin_turn_stack_output(
                    environment or "development", "TurnQueueUrl"
                )
            except Exception as error:
                print(
                    "computer_queue lookup needs AWS credentials "
                    f"({error.__class__.__name__}). Reauthenticate with aws login.",
                    file=sys.stderr,
                )
                client.post(
                    org_path(args.tenant_id, "/computers/stopped"),
                    json={"user_id": args.user_id, "stopped": True},
                )
                return 1
            computer_body = _sqs_receive_computer_continuation(
                computer_queue,
                job_id=job_id,
                turn_id=browser_turn_id,
                wait_seconds=20,
            )
            waiting_for = "browser"
            status = None
            has_tool_result = False
            journal_events: list[dict] = []
            host_deadline = time.monotonic() + 180
            while time.monotonic() < host_deadline:
                still_waiting = client.get(org_path(args.tenant_id, f"/turns/{browser_turn_id}"))
                payload = still_waiting.json()
                waiting_for = payload.get("waiting_for")
                status = payload.get("status")
                events_response = client.get(org_path(args.tenant_id, f"/turns/{browser_turn_id}/events"))
                journal_events = events_response.json().get("events") or []
                tool_result_bodies = _tool_result_bodies(journal_events)
                has_tool_result = bool(tool_result_bodies)
                if (
                    has_tool_result
                    or status == "completed"
                    or waiting_for in (None, "")
                ):
                    break
                time.sleep(5)
            host_completed = (
                has_tool_result or status == "completed" or waiting_for in (None, "")
            )
            if computer_body is None:
                if host_completed:
                    print("computer_queue_job=completed")
                elif waiting_for != "browser":
                    print(
                        "computer_queue delivered no matching message "
                        f"waiting_for={waiting_for!r}",
                        file=sys.stderr,
                    )
                    client.post(
                        org_path(args.tenant_id, "/computers/stopped"),
                        json={"user_id": args.user_id, "stopped": True},
                    )
                    return 1
                else:
                    print("computer_queue_job=in_flight_nack")
            else:
                print("computer_queue_job=computer")
            cpu_message = _sqs_receive_one(cpu_queue, wait_seconds=2)
            if cpu_message is not None:
                cpu_body = json.loads(cpu_message["Body"])
                if cpu_body.get("job_id") == job_id:
                    print(
                        "cpu_queue received the computer continuation", file=sys.stderr
                    )
                    client.post(
                        org_path(args.tenant_id, "/computers/stopped"),
                        json={"user_id": args.user_id, "stopped": True},
                    )
                    return 1
            client.post(
                org_path(args.tenant_id, "/computers/stopped"),
                json={"user_id": args.user_id, "stopped": True},
            )
            still = client.get(org_path(args.tenant_id, f"/turns/{browser_turn_id}"))
            if host_completed:
                if not journal_events:
                    events_response = client.get(org_path(args.tenant_id, f"/turns/{browser_turn_id}/events"))
                    journal_events = events_response.json().get("events") or []
                chromium_result = _chromium_host_tool_result_body(journal_events)
                if chromium_result is None:
                    print(
                        "computer_tool_result expected opened:<url> from Chromium "
                        f"host; got {_tool_result_bodies(journal_events)!r}",
                        file=sys.stderr,
                    )
                    return 1
                print(f"computer_tool_result={chromium_result}")
                print("computer_queue_turn_completed=1")
            elif still.json().get("waiting_for") != "browser":
                print(
                    f"after_computer_queue waiting_for="
                    f"{still.json().get('waiting_for')!r}",
                    file=sys.stderr,
                )
                return 1
            else:
                print("computer_queue_turn_still_waiting=browser")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
