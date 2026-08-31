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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
