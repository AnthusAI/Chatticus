"""Watch a live thin-turn conversation from the command line."""

from __future__ import annotations

import argparse
import sys

from chatticus.thin_turn_conversation import (
    ThinTurnConversationClient,
    cloud_environment_choices,
    resolve_demo_base_url,
    resolve_demo_invoke_key,
)


def _print_token(token: str) -> None:
    sys.stdout.write(token)
    sys.stdout.flush()


def _run_turn(
    client: ThinTurnConversationClient,
    turn_id: str,
    *,
    after_seq: int = 0,
) -> int:
    def on_event(event: dict) -> None:
        if event.get("kind") == "turn.token" and event.get("token") is not None:
            _print_token(str(event["token"]))

    if after_seq:
        outcome = client.watch_turn_stream(
            turn_id,
            after_seq=after_seq,
            on_event=on_event,
        )
    else:
        outcome = client.watch_turn_with_reconnect(
            turn_id,
            on_token=_print_token,
        )
    if outcome.committed_body is None:
        print(file=sys.stderr)
        print("turn did not complete", file=sys.stderr)
        return 1
    print()
    print(f"bot> {outcome.committed_body}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Post a message to a named bot and watch one thin-turn SSE stream. "
            "Auth is invoke key plus /orgs/{tenant_id}/... paths, not product login."
        )
    )
    parser.add_argument(
        "--environment",
        choices=cloud_environment_choices(),
        help="Named cloud environment (development, staging, production).",
    )
    parser.add_argument(
        "--base-url",
        default="",
        help="CloudFront origin https://... Overrides --environment lookup.",
    )
    parser.add_argument("--tenant-id", default="anthus")
    parser.add_argument("--user-id", default="ryan")
    parser.add_argument(
        "--invoke-key",
        default="",
        help="Thin-turn invoke key. Defaults to CHATTICUS_INVOKE_KEY.",
    )
    parser.add_argument(
        "--bot",
        required=True,
        help="Named bot to address on the channel.",
    )
    parser.add_argument(
        "--channel-id",
        default="",
        help="Existing channel id. When omitted, reuse or open one for the bot.",
    )
    parser.add_argument(
        "--message",
        default="",
        help="Single message to post. When omitted, read lines interactively.",
    )
    parser.add_argument(
        "--list-turns",
        action="store_true",
        help="List in-flight turns (GET /users/{user_id}/turns) and exit.",
    )
    parser.add_argument(
        "--watch-turn",
        default="",
        help="Watch an existing turn id without posting a new message.",
    )
    parser.add_argument(
        "--after-seq",
        type=int,
        default=0,
        help="Last-Event-ID cursor when using --watch-turn.",
    )
    args = parser.parse_args()
    try:
        invoke_key = resolve_demo_invoke_key(args.environment, args.invoke_key)
    except (LookupError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 2
    try:
        base_url = resolve_demo_base_url(
            args.environment or None, args.base_url or None
        )
    except (LookupError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 2
    if args.environment:
        print(f"environment={args.environment} base_url={base_url}", file=sys.stderr)
    client = ThinTurnConversationClient(
        tenant_id=args.tenant_id,
        user_id=args.user_id,
        invoke_key=invoke_key or None,
        base_url=base_url,
    )
    try:
        health = client._client.get("/health")
        if health.status_code != 200:
            print(f"health {health.status_code}", file=sys.stderr)
            return 1
        if args.list_turns:
            turns = client.list_active_turns()
            for row in turns:
                print(
                    f"turn_id={row.get('turn_id')} "
                    f"channel_id={row.get('channel_id')} "
                    f"bot_id={row.get('bot_id')}"
                )
            if not turns:
                print("no in-flight turns")
            return 0
        if args.watch_turn:
            return _run_turn(client, args.watch_turn, after_seq=args.after_seq)
        bot = client.ensure_bot(args.bot)
        if args.channel_id:
            channel_id = args.channel_id
        else:
            channel = client.find_or_open_channel(bot["bot_id"])
            channel_id = channel["channel_id"]
        if args.message:
            messages = [args.message]
        else:
            print(f"channel_id={channel_id} bot={args.bot}", file=sys.stderr)
            messages = []
            while True:
                try:
                    line = input("you> ")
                except EOFError:
                    break
                if not line.strip():
                    continue
                messages.append(line)
        if not messages:
            return 0
        exit_code = 0
        for body in messages:
            turn_id, _ = client.post_message(channel_id, body, bot["bot_id"])
            print(f"turn_id={turn_id}", file=sys.stderr)
            code = _run_turn(client, turn_id)
            if code != 0:
                exit_code = code
        return exit_code
    finally:
        client.close()


if __name__ == "__main__":
    raise SystemExit(main())
