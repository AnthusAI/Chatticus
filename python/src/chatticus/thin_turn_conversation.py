"""Human-facing thin-turn conversation over the live Front Door HTTP surface."""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4

import httpx

from chatticus.cloud_environments import (
    CLOUD_ENVIRONMENTS,
    parse_cloud_environment,
    resolve_invoke_key_for_environment,
    resolve_thin_turn_base_url,
)
from chatticus.http.app import INVOKE_HEADER
from chatticus.http.paths import org_path
from chatticus.models import ActorKind

EventCallback = Callable[[dict[str, Any]], None]


def front_door_headers(
    invoke_key: str | None = None,
) -> dict[str, str]:
    """Return optional invoke-key headers for the thin-turn API."""
    headers: dict[str, str] = {}
    key = (invoke_key or "").strip()
    if key:
        headers[INVOKE_HEADER] = key
    return headers


def parse_sse_data_frames(buffer: str) -> tuple[list[dict[str, Any]], str]:
    """Parse complete SSE data frames from a growing text buffer."""
    events: list[dict[str, Any]] = []
    while "\n\n" in buffer:
        frame, buffer = buffer.split("\n\n", 1)
        for line in frame.split("\n"):
            if line.startswith("data:"):
                events.append(json.loads(line[5:].strip()))
    return events, buffer


@dataclass
class TurnWatchOutcome:
    """Events and derived text collected from one or more stream reads."""

    events: list[dict[str, Any]] = field(default_factory=list)
    tokens: list[str] = field(default_factory=list)
    committed_body: str | None = None
    last_seq: int = 0

    def absorb(self, batch: list[dict[str, Any]]) -> None:
        """Append events and update derived token and completion fields."""
        for event in batch:
            self.events.append(event)
            self.last_seq = max(self.last_seq, int(event.get("seq", 0)))
            if event.get("kind") == "turn.token" and event.get("token") is not None:
                self.tokens.append(str(event["token"]))
            if event.get("kind") == "turn.completed":
                body = event.get("body")
                if body is not None:
                    self.committed_body = str(body)


class ThinTurnConversationClient:
    """POST one message and watch turn-scoped SSE on the thin-turn front door."""

    def __init__(
        self,
        *,
        tenant_id: str,
        user_id: str,
        invoke_key: str | None = None,
        base_url: str | None = None,
        client: httpx.Client | None = None,
        timeout: float = 120.0,
    ) -> None:
        self.tenant_id = tenant_id
        self.user_id = user_id
        self._headers = front_door_headers(invoke_key)
        if client is not None:
            self._client = client
            self._owns_client = False
        else:
            if not base_url:
                raise ValueError("base_url is required when client is not provided")
            self._client = httpx.Client(
                base_url=base_url.rstrip("/"),
                headers=self._headers,
                timeout=timeout,
            )
            self._owns_client = True

    def _org(self, suffix: str) -> str:
        return org_path(self.tenant_id, suffix)

    def _merged_headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        """Return tenant headers merged with per-request values."""
        headers = dict(self._headers)
        if extra:
            headers.update(extra)
        return headers

    def close(self) -> None:
        """Close the underlying HTTP client when this object created it."""
        if self._owns_client:
            self._client.close()

    def lookup_bot(self, name: str) -> dict[str, Any] | None:
        """Return a named bot or None when GET /bots?user_id=&name= is 404."""
        response = self._client.get(
            self._org("/bots"),
            params={"user_id": self.user_id, "name": name},
            headers=self._merged_headers(),
        )
        if response.status_code == 404:
            return None
        if response.status_code >= 400:
            raise RuntimeError(
                f"bot lookup failed {response.status_code}: {response.text[:300]}"
            )
        return response.json()

    def create_bot(self, name: str) -> dict[str, Any]:
        """Create a named bot with POST /bots and a fresh idempotency key."""
        response = self._client.post(
            self._org("/bots"),
            json={"user_id": self.user_id, "name": name},
            headers=self._merged_headers({"Idempotency-Key": str(uuid4())}),
        )
        if response.status_code >= 400:
            raise RuntimeError(
                f"bot create failed {response.status_code}: {response.text[:300]}"
            )
        return response.json()

    def ensure_bot(self, name: str) -> dict[str, Any]:
        """Look up a named bot or create it when missing."""
        found = self.lookup_bot(name)
        if found is not None:
            return found
        return self.create_bot(name)

    def list_channels(self) -> list[dict[str, Any]]:
        """Return GET /users/{user_id}/channels rows."""
        response = self._client.get(
            self._org(f"/users/{self.user_id}/channels"),
            headers=self._merged_headers(),
        )
        if response.status_code >= 400:
            raise RuntimeError(
                f"channels list failed {response.status_code}: {response.text[:300]}"
            )
        return list(response.json().get("channels") or [])

    def list_active_turns(self) -> list[dict[str, Any]]:
        """Return in-flight turns from GET /users/{user_id}/turns."""
        response = self._client.get(
            self._org(f"/users/{self.user_id}/turns"),
            headers=self._merged_headers(),
        )
        if response.status_code >= 400:
            raise RuntimeError(
                f"turns list failed {response.status_code}: {response.text[:300]}"
            )
        return list(response.json().get("turns") or [])

    def channel_turn(self, channel_id: str) -> dict[str, Any] | None:
        """Return GET /channels/{id}/turn or None when no active turn exists."""
        response = self._client.get(
            self._org(f"/channels/{channel_id}/turn"),
            headers=self._merged_headers(),
        )
        if response.status_code == 404:
            return None
        if response.status_code >= 400:
            raise RuntimeError(
                f"channel turn failed {response.status_code}: {response.text[:300]}"
            )
        return response.json()

    def open_channel(self, bot_ids: list[str]) -> dict[str, Any]:
        """Open a channel with POST /channels."""
        response = self._client.post(
            self._org("/channels"),
            json={"user_id": self.user_id, "bot_ids": bot_ids},
            headers=self._merged_headers({"Idempotency-Key": str(uuid4())}),
        )
        if response.status_code >= 400:
            raise RuntimeError(
                f"channel open failed {response.status_code}: {response.text[:300]}"
            )
        return response.json()

    def find_or_open_channel(self, bot_id: str) -> dict[str, Any]:
        """Reuse the first channel that already includes the bot, or open one."""
        for channel in self.list_channels():
            participants = channel.get("participants") or []
            actor_ids = {
                row.get("actor_id")
                for row in participants
                if row.get("kind") in (ActorKind.BOT, "bot")
            }
            if bot_id in actor_ids:
                return channel
        return self.open_channel([bot_id])

    def post_message(
        self,
        channel_id: str,
        body: str,
        bot_id: str,
        *,
        idempotency_key: str | None = None,
    ) -> tuple[str, str]:
        """POST /channels/{id}/messages and return (turn_id, message_id)."""
        headers: dict[str, str] = {}
        key = (idempotency_key or "").strip()
        if key:
            headers["Idempotency-Key"] = key
        response = self._client.post(
            self._org(f"/channels/{channel_id}/messages"),
            json={
                "author_kind": ActorKind.HUMAN,
                "author_id": self.user_id,
                "body": body,
                "addressed_to_bot_id": bot_id,
            },
            headers=self._merged_headers(headers),
        )
        if response.status_code >= 400:
            raise RuntimeError(
                f"message post failed {response.status_code}: {response.text[:300]}"
            )
        payload = response.json()
        turn_id = payload.get("turn_id")
        message = payload.get("message") or {}
        if not turn_id:
            raise RuntimeError("message post did not start a turn")
        return str(turn_id), str(message.get("message_id", ""))

    def list_turn_events(
        self, turn_id: str, after_seq: int = 0
    ) -> list[dict[str, Any]]:
        """Return GET /turns/{id}/events?after= rows."""
        response = self._client.get(
            self._org(f"/turns/{turn_id}/events"),
            params={"after": after_seq},
            headers=self._merged_headers(),
        )
        if response.status_code >= 400:
            raise RuntimeError(
                f"turn events failed {response.status_code}: {response.text[:300]}"
            )
        return list(response.json().get("events") or [])

    def list_channel_messages(
        self, channel_id: str, after_seq: int = 0
    ) -> list[dict[str, Any]]:
        """Return GET /channels/{id}/messages?after= rows."""
        response = self._client.get(
            self._org(f"/channels/{channel_id}/messages"),
            params={"after": after_seq},
            headers=self._merged_headers(),
        )
        if response.status_code >= 400:
            raise RuntimeError(
                f"channel messages failed {response.status_code}: {response.text[:300]}"
            )
        return list(response.json().get("messages") or [])

    def watch_turn_stream(
        self,
        turn_id: str,
        *,
        after_seq: int = 0,
        on_event: EventCallback | None = None,
        stop_after_token_count: int | None = None,
        timeout: float = 120.0,
    ) -> TurnWatchOutcome:
        """Read GET /turns/{id}/stream until completion or an early stop."""
        outcome = TurnWatchOutcome()
        headers: dict[str, str] = {}
        if after_seq:
            headers["Last-Event-ID"] = str(after_seq)
        deadline = time.monotonic() + timeout
        with self._client.stream(
            "GET",
            self._org(f"/turns/{turn_id}/stream"),
            headers=self._merged_headers(headers),
        ) as response:
            if response.status_code != 200:
                raise RuntimeError(
                    f"stream failed {response.status_code}: "
                    f"{response.read().decode()[:300]}"
                )
            buffer = ""
            token_count = 0
            for chunk in response.iter_bytes():
                if time.monotonic() > deadline:
                    break
                buffer += chunk.decode()
                parsed, buffer = parse_sse_data_frames(buffer)
                for event in parsed:
                    outcome.absorb([event])
                    if on_event is not None:
                        on_event(event)
                    if event.get("kind") == "turn.token":
                        token_count += 1
                        if (
                            stop_after_token_count is not None
                            and token_count >= stop_after_token_count
                        ):
                            response.close()
                            return outcome
                    if event.get("kind") in (
                        "turn.completed",
                        "turn.failed",
                        "turn.reconciling",
                    ):
                        return outcome
        return outcome

    def watch_turn_with_reconnect(
        self,
        turn_id: str,
        *,
        on_token: Callable[[str], None] | None = None,
        drop_after_token_count: int | None = None,
        timeout: float = 120.0,
    ) -> TurnWatchOutcome:
        """Watch a turn, optionally dropping after N tokens and reconnecting."""
        combined = TurnWatchOutcome()

        def absorb(event: dict[str, Any]) -> None:
            if event.get("kind") == "turn.token" and event.get("token") is not None:
                token = str(event["token"])
                if on_token is not None:
                    on_token(token)

        first = self.watch_turn_stream(
            turn_id,
            on_event=absorb,
            stop_after_token_count=drop_after_token_count,
            timeout=timeout,
        )
        combined.absorb(first.events)
        if first.committed_body is not None:
            return combined
        if drop_after_token_count is None:
            return combined
        resume_after = first.last_seq
        second = self.watch_turn_stream(
            turn_id,
            after_seq=resume_after,
            on_event=absorb,
            timeout=timeout,
        )
        combined.absorb(second.events)
        return combined


def resolve_demo_invoke_key(
    environment: str | None,
    invoke_key: str | None,
) -> str | None:
    """Resolve invoke key for the demo CLI when targeting a named environment."""
    explicit = (invoke_key or "").strip()
    if explicit:
        return explicit
    if not environment:
        return None
    return resolve_invoke_key_for_environment(parse_cloud_environment(environment))


def resolve_demo_base_url(
    environment: str | None,
    base_url: str | None,
) -> str:
    """Resolve a thin-turn CloudFront origin for the demo CLI."""
    if base_url:
        return base_url.rstrip("/")
    if not environment:
        raise ValueError("pass --environment or --base-url")
    return resolve_thin_turn_base_url(parse_cloud_environment(environment))


def cloud_environment_choices() -> tuple[str, ...]:
    """Return named cloud environments accepted by the demo CLI."""
    return CLOUD_ENVIRONMENTS
