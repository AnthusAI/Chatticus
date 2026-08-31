"""Exercise a deployed Chatticus thin turn through the CloudFront front door."""

from __future__ import annotations

import argparse
import json
import sys
import time
from uuid import uuid4

import httpx

from chatticus.cloud_environments import (
    CLOUD_ENVIRONMENTS,
    parse_cloud_environment,
    resolve_thin_turn_base_url,
)
from chatticus.models import ActorKind


def _frames(buffer: str) -> tuple[list[dict], str]:
    events: list[dict] = []
    while "\n\n" in buffer:
        frame, buffer = buffer.split("\n\n", 1)
        for line in frame.split("\n"):
            if line.startswith("data:"):
                events.append(json.loads(line[5:].strip()))
    return events, buffer


def main() -> int:
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
    if args.invoke_key:
        headers["X-Chatticus-Invoke-Key"] = args.invoke_key
    with httpx.Client(base_url=base_url, headers=headers, timeout=120.0) as client:
        health = client.get("/health")
        if health.status_code != 200:
            print(f"health {health.status_code} {health.text[:200]}", file=sys.stderr)
            return 1
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
        bot_response = client.post(
            "/bots",
            json={"user_id": args.user_id, "name": f"ExerciseBot-{uuid4().hex[:8]}"},
        )
        if bot_response.status_code >= 400:
            print(
                f"bots {bot_response.status_code} {bot_response.text[:300]}",
                file=sys.stderr,
            )
            return 1
        bot = bot_response.json()
        client.post(
            "/computers/stopped", json={"user_id": args.user_id, "stopped": True}
        )
        channel = client.post(
            "/channels",
            json={"user_id": args.user_id, "bot_ids": [bot["bot_id"]]},
        ).json()
        fence_posted = client.post(
            f"/channels/{channel['channel_id']}/messages",
            json={
                "author_kind": ActorKind.HUMAN,
                "author_id": args.user_id,
                "body": "Fence probe; do not wait on this turn.",
                "addressed_to_bot_id": bot["bot_id"],
            },
        ).json()
        fence_turn_id = fence_posted["turn_id"]
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
        if acquired and claim_b.status_code != 409:
            print(
                "second claim did not get 409 while the lease was held",
                file=sys.stderr,
            )
            return 1
        if not acquired and claim_a.status_code != 409:
            print(
                f"fence claim unexpected {claim_a.status_code} {claim_a.text[:300]}",
                file=sys.stderr,
            )
            return 1
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
            waiting_kinds: list[str] = []
            with client.stream("GET", f"/turns/{fence_turn_id}/stream") as stream:
                stream.raise_for_status()
                buffer = ""
                deadline = time.time() + 30
                for chunk in stream.iter_bytes():
                    buffer += chunk.decode()
                    parsed, buffer = _frames(buffer)
                    waiting_kinds.extend(event.get("kind") for event in parsed)
                    if "turn.waiting" in waiting_kinds:
                        break
                    if time.time() > deadline:
                        break
            print(f"waiting_stream_kinds={waiting_kinds}")
            if "turn.waiting" not in waiting_kinds:
                print("fence turn did not emit turn.waiting", file=sys.stderr)
                return 1
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
        posted_response = client.post(
            f"/channels/{channel['channel_id']}/messages",
            json={
                "author_kind": ActorKind.HUMAN,
                "author_id": args.user_id,
                "body": "Reply with a short greeting.",
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
        with client.stream("GET", f"/turns/{turn_id}/stream") as stream:
            stream.raise_for_status()
            buffer = ""
            for chunk in stream.iter_bytes():
                buffer += chunk.decode()
                parsed, buffer = _frames(buffer)
                events.extend(parsed)
                if events and events[-1].get("kind") == "turn.completed":
                    break
        kinds = [event.get("kind") for event in events]
        print(f"first_stream_kinds={kinds}")
        if "turn.completed" not in kinds:
            print("first stream did not complete", file=sys.stderr)
            return 1
        cutoff = max(1, events[1]["seq"] if len(events) > 1 else 1)
        replayed: list[dict] = []
        with client.stream(
            "GET",
            f"/turns/{turn_id}/stream",
            params={"after_seq": cutoff},
        ) as stream:
            stream.raise_for_status()
            buffer = ""
            deadline = time.time() + 30
            for chunk in stream.iter_bytes():
                buffer += chunk.decode()
                parsed, buffer = _frames(buffer)
                replayed.extend(parsed)
                if replayed and replayed[-1].get("kind") == "turn.completed":
                    break
                if time.time() > deadline:
                    break
        print(
            f"reconnect_after={cutoff} replay_kinds={[e.get('kind') for e in replayed]}"
        )
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
        if not any(event.get("kind") == "turn.completed" for event in replayed):
            print("reconnect did not replay completion", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
