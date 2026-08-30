"""Exercise a deployed Chatticus thin turn through the CloudFront front door."""

from __future__ import annotations

import argparse
import json
import sys
import time
from uuid import uuid4

import httpx

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
    parser.add_argument("--base-url", required=True, help="CloudFront origin, https://...")
    parser.add_argument("--tenant-id", default="anthus")
    parser.add_argument("--user-id", default="ryan")
    parser.add_argument("--invoke-key", default="")
    args = parser.parse_args()
    headers = {"X-Tenant-Id": args.tenant_id}
    if args.invoke_key:
        headers["X-Chatticus-Invoke-Key"] = args.invoke_key
    with httpx.Client(base_url=args.base_url.rstrip("/"), headers=headers, timeout=120.0) as client:
        health = client.get("/health")
        health.raise_for_status()
        bot = client.post(
            "/bots",
            json={"user_id": args.user_id, "name": f"ExerciseBot-{uuid4().hex[:8]}"},
        ).json()
        client.post("/computers/stopped", json={"user_id": args.user_id, "stopped": True})
        channel = client.post(
            "/channels",
            json={"user_id": args.user_id, "bot_ids": [bot["bot_id"]]},
        ).json()
        posted = client.post(
            f"/channels/{channel['channel_id']}/messages",
            json={
                "author_kind": ActorKind.HUMAN,
                "author_id": args.user_id,
                "body": "Reply with a short greeting.",
                "addressed_to_bot_id": bot["bot_id"],
            },
        ).json()
        turn_id = posted["turn_id"]
        print(f"tenant_id={args.tenant_id} channel_id={channel['channel_id']} turn_id={turn_id}")
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
        print(f"reconnect_after={cutoff} replay_kinds={[e.get('kind') for e in replayed]}")
        stopped = client.get("/computers/stopped", params={"user_id": args.user_id}).json()
        messages = client.get(f"/channels/{channel['channel_id']}/messages").json()["messages"]
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
