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
    resolve_thin_turn_base_url,
    thin_turn_stack_output,
)
from chatticus.models import ActorKind
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

    def stream(self, method: str, path: str, **kwargs: Any) -> Any:
        return self._client.stream(method, f"{self._prefix}{path}", **kwargs)

    def __enter__(self) -> "SameOriginApiClient":
        self._client.__enter__()
        return self

    def __exit__(self, *args: Any) -> None:
        self._client.__exit__(*args)


def _invoke_key_for_environment(environment: str) -> str:
    """Read the front-door invoke key from the named stack secret."""
    import boto3

    arn = thin_turn_stack_output(environment, "InvokeKeySecretArn")
    region = (
        os.environ.get("AWS_REGION")
        or os.environ.get("AWS_DEFAULT_REGION")
        or "us-east-1"
    )
    secret = boto3.client("secretsmanager", region_name=region).get_secret_value(
        SecretId=arn
    )
    return secret["SecretString"]


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
    headers = {"X-Tenant-Id": args.tenant_id}
    invoke_key = args.invoke_key
    if not invoke_key and environment is not None:
        invoke_key = _invoke_key_for_environment(environment)
    if invoke_key:
        headers["X-Chatticus-Invoke-Key"] = invoke_key
    with SameOriginApiClient(base_url, headers=headers, timeout=900.0) as client:
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
        missing = client.post(
            "/turns/missing-turn-id/claim",
            json={"worker_id": "exercise-missing"},
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
            "/bots",
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
            "/bots",
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
            "/bots",
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
            "/bots",
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
        listed_bots = client.get(f"/users/{args.user_id}/bots")
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
        remembered = client.post(
            f"/bots/{bot['bot_id']}/memory",
            json={"key": "voice", "value": "short and direct"},
        )
        if remembered.status_code != 200:
            print(
                f"bot_memory {remembered.status_code} {remembered.text[:300]}",
                file=sys.stderr,
            )
            return 1
        fetched = client.get(f"/bots/{bot['bot_id']}")
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
            "/computers/stopped", json={"user_id": args.user_id, "stopped": True}
        )
        computer = client.get(f"/users/{args.user_id}/computer")
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
            "/channels",
            json=channel_body,
            headers={"Idempotency-Key": channel_key},
        )
        second_channel = client.post(
            "/channels",
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
        channel_get = client.get(f"/channels/{channel['channel_id']}")
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
        listed_channels = client.get(f"/users/{args.user_id}/channels")
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
            f"/channels/{channel['channel_id']}/messages",
            json={
                "author_kind": ActorKind.HUMAN,
                "author_id": args.user_id,
                "body": "Fence probe; do not wait on this turn.",
                "addressed_to_bot_id": bot["bot_id"],
                "enqueue_turn": False,
            },
        ).json()
        fence_turn_id = fence_posted["turn_id"]
        channel_turn = client.get(f"/channels/{channel['channel_id']}/turn")
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
        listed_turns = client.get(f"/users/{args.user_id}/turns")
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
        claim_a = client.post(
            f"/turns/{fence_turn_id}/claim",
            json={"worker_id": "exercise-fence-a"},
        )
        claim_b = client.post(
            f"/turns/{fence_turn_id}/claim",
            json={"worker_id": "exercise-fence-b"},
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
            f"/channels/{channel['channel_id']}/messages",
            json=idem_body,
            headers={"Idempotency-Key": idem_key},
        )
        second_idem = client.post(
            f"/channels/{channel['channel_id']}/messages",
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
        listed = client.get(f"/channels/{channel['channel_id']}/messages")
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
                f"/turns/{fence_turn_id}/chunks",
                json={
                    "token": "Here is a draft.",
                    "complete": False,
                    "fence_token": fence_token,
                },
            )
            if draft.status_code >= 400:
                print(
                    f"waiting_draft {draft.status_code} {draft.text[:300]}",
                    file=sys.stderr,
                )
                return 1
            waiting = client.post(
                f"/turns/{fence_turn_id}/waiting",
                json={"gate": "browser", "fence_token": fence_token},
            )
            if waiting.status_code >= 400:
                print(
                    f"waiting_post {waiting.status_code} {waiting.text[:300]}",
                    file=sys.stderr,
                )
                return 1
            turn_read = client.get(f"/turns/{fence_turn_id}")
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
            channel_waiting = client.get(f"/channels/{channel['channel_id']}/turn")
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
            with client.stream("GET", f"/turns/{fence_turn_id}/stream") as stream:
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
                f"/turns/{fence_turn_id}/waiting",
                json={"gate": "browser", "fence_token": fence_token},
            )
            if stale_waiting.status_code != 409:
                print(
                    f"stale_waiting {stale_waiting.status_code} "
                    f"{stale_waiting.text[:300]}",
                    file=sys.stderr,
                )
                return 1
            print("stale_waiting=409")
            resume_stopped = client.post(f"/turns/{fence_turn_id}/resume")
            if resume_stopped.status_code != 409:
                print(
                    f"resume_while_stopped {resume_stopped.status_code} "
                    f"{resume_stopped.text[:300]}",
                    file=sys.stderr,
                )
                return 1
            print("resume_while_stopped=409")
            finisher = client.post(
                f"/turns/{fence_turn_id}/claim",
                json={"worker_id": "exercise-waiting-finisher"},
            )
            if finisher.status_code == 200 and finisher.json().get("acquired"):
                complete = client.post(
                    f"/turns/{fence_turn_id}/chunks",
                    json={
                        "token": "",
                        "complete": True,
                        "fence_token": finisher.json()["fence_token"],
                    },
                )
                if complete.status_code >= 400:
                    print(
                        f"waiting_complete {complete.status_code} "
                        f"{complete.text[:300]}",
                        file=sys.stderr,
                    )
                    return 1
        posted_response = client.post(
            f"/channels/{channel['channel_id']}/messages",
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
        with client.stream("GET", f"/turns/{turn_id}/stream") as stream:
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
                if events and events[-1].get("kind") == "turn.completed":
                    break
                if time.time() > deadline:
                    break
        kinds = [event.get("kind") for event in events]
        print(f"first_stream_kinds={kinds} dropped_mid_stream={dropped_mid_stream}")
        if not events:
            print("first stream delivered no events", file=sys.stderr)
            return 1
        if dropped_mid_stream:
            reconnect_after = events[-1]["seq"]
        else:
            reconnect_after = max(1, events[0]["seq"])
        print(f"reconnect_last_event_id={reconnect_after}")
        resumed: list[dict] = []
        with client.stream(
            "GET",
            f"/turns/{turn_id}/stream",
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
        all_events = events + resumed
        seqs = [event["seq"] for event in all_events]
        if len(seqs) != len(set(seqs)):
            print(f"duplicate seqs across drop/reconnect: {seqs}", file=sys.stderr)
            return 1
        if seqs != sorted(seqs):
            print(f"out-of-order seqs: {seqs}", file=sys.stderr)
            return 1
        if resumed and min(event["seq"] for event in resumed) <= reconnect_after:
            print(
                f"reconnect replayed seq at or before Last-Event-ID={reconnect_after}",
                file=sys.stderr,
            )
            return 1
        if not any(event.get("kind") == "turn.completed" for event in all_events):
            print("reconnect did not reach turn.completed", file=sys.stderr)
            return 1
        stopped_response = client.get(
            "/computers/stopped", params={"user_id": args.user_id}
        )
        if stopped_response.status_code != 200:
            print(
                f"stopped {stopped_response.status_code} {stopped_response.text[:300]}",
                file=sys.stderr,
            )
            return 1
        stopped = stopped_response.json()
        listed = client.get(f"/channels/{channel['channel_id']}/messages")
        if listed.status_code != 200:
            print(f"messages {listed.status_code} {listed.text[:300]}", file=sys.stderr)
            return 1
        messages = listed.json()["messages"]
        bot_messages = [m for m in messages if m["author_kind"] == ActorKind.BOT]
        print(f"computer_stopped={stopped['stopped']} bot_messages={len(bot_messages)}")
        if not stopped["stopped"] or not bot_messages:
            return 1
        channel_turn_done = client.get(f"/channels/{channel['channel_id']}/turn")
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
            f"/channels/{channel['channel_id']}/messages",
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
            f"/turns/{turn_id}/events",
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
        browser_post = client.post(
            f"/channels/{channel['channel_id']}/messages",
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
        with client.stream("GET", f"/turns/{browser_turn_id}/stream") as stream:
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
        model_turn_read = client.get(f"/turns/{browser_turn_id}")
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
        model_resume = client.post(f"/turns/{browser_turn_id}/resume")
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
                "/computers/stopped",
                json={"user_id": args.user_id, "stopped": False},
            )
            resumed_running = client.post(f"/turns/{browser_turn_id}/resume")
            if resumed_running.status_code != 200:
                print(
                    f"resume_while_running {resumed_running.status_code} "
                    f"{resumed_running.text[:300]}",
                    file=sys.stderr,
                )
                client.post(
                    "/computers/stopped",
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
                    "/computers/stopped",
                    json={"user_id": args.user_id, "stopped": True},
                )
                return 1
            print("resume_required_capabilities=computer")
            if not job_id:
                print(f"resume_payload={resume_payload!r}", file=sys.stderr)
                client.post(
                    "/computers/stopped",
                    json={"user_id": args.user_id, "stopped": True},
                )
                return 1
            generation = None
            deadline = time.monotonic() + 25
            while time.monotonic() < deadline:
                computer_after = client.get(f"/users/{args.user_id}/computer")
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
                    "/computers/stopped",
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
                    "/computers/stopped",
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
            host_deadline = time.monotonic() + 180
            while time.monotonic() < host_deadline:
                still_waiting = client.get(f"/turns/{browser_turn_id}")
                payload = still_waiting.json()
                waiting_for = payload.get("waiting_for")
                status = payload.get("status")
                events_response = client.get(f"/turns/{browser_turn_id}/events")
                has_tool_result = any(
                    event.get("kind") == "tool.result"
                    for event in (events_response.json().get("events") or [])
                )
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
                        "/computers/stopped",
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
                        "/computers/stopped",
                        json={"user_id": args.user_id, "stopped": True},
                    )
                    return 1
            client.post(
                "/computers/stopped",
                json={"user_id": args.user_id, "stopped": True},
            )
            still = client.get(f"/turns/{browser_turn_id}")
            if host_completed:
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
