"""Durable channel, message, turn event, and chunk persistence."""

from __future__ import annotations

import json
import threading
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from chatticus.models import (
    ActorKind,
    Bot,
    Channel,
    ChannelParticipant,
    Computer,
    ComputerPolicy,
    Message,
    PendingComputerToolSnapshot,
    StaleAttemptError,
    Turn,
    TurnEvent,
    TurnEventKind,
    TurnStatus,
)


class MessagingStore(Protocol):
    """Append-only channel transcript and turn event log."""

    def put_channel(self, channel: Channel) -> None:
        """Persist channel metadata."""

    def get_channel(self, tenant_id: str, channel_id: str) -> Channel | None:
        """Load one channel."""

    def resolve_channel_tenant(self, channel_id: str) -> str | None:
        """Return the owning tenant for a channel identifier."""

    def put_message(self, message: Message) -> None:
        """Persist one committed message row."""

    def list_messages(
        self, tenant_id: str, channel_id: str, after_seq: int = 0
    ) -> list[Message]:
        """Return messages with seq greater than after_seq."""

    def put_turn(self, turn: Turn, *, expected_fence: int | None = None) -> None:
        """Persist turn metadata, optionally requiring the current fence."""

    def get_turn(self, tenant_id: str, turn_id: str) -> Turn | None:
        """Load one turn."""

    def claim_turn_attempt(
        self,
        tenant_id: str,
        turn_id: str,
        worker_id: str,
        attempt_id: str,
        now: datetime,
        lease_expires_at: datetime,
    ) -> tuple[Turn, bool] | None:
        """Conditionally take ownership of an active turn.

        Returns ``(turn, True)`` when this call became owner, ``(turn, False)``
        when this worker already owns an unexpired lease, or ``None`` when
        another worker holds the lease.
        """

    def renew_turn_lease(
        self,
        tenant_id: str,
        turn_id: str,
        worker_id: str,
        fence_token: int,
        lease_expires_at: datetime,
    ) -> Turn | None:
        """Extend the lease for the fenced owner, or return None if fenced out."""

    def put_turn_event(self, event: TurnEvent) -> None:
        """Persist one durable turn event."""

    def list_turn_events(
        self, tenant_id: str, turn_id: str, after_seq: int = 0
    ) -> list[TurnEvent]:
        """Return turn events with seq greater than after_seq."""

    def put_bot(self, bot: Bot) -> None:
        """Persist a named bot."""

    def get_bot(self, tenant_id: str, bot_id: str) -> Bot | None:
        """Load one bot."""

    def put_computer(self, computer: Computer) -> None:
        """Persist the household computer record."""

    def get_computer(self, tenant_id: str, user_id: str) -> Computer | None:
        """Load the household computer for a user."""

    def put_turn_chunk(
        self,
        tenant_id: str,
        turn_id: str,
        chunk_seq: int,
        token: str,
        expires_at: datetime,
    ) -> bool:
        """Persist one in-flight chunk with TTL metadata.

        Returns True when a new chunk was stored, False when retried idempotently.
        """

    def list_turn_chunks(self, tenant_id: str, turn_id: str) -> list[str]:
        """Return chunk tokens in order."""

    def record_logical_enqueue(
        self, tenant_id: str, turn_id: str, enqueue_id: str
    ) -> bool:
        """Return True on the first delivery of ``enqueue_id`` for the turn."""


class InMemoryMessagingStore:
    """In-memory store for fast kernel tests."""

    def __init__(self) -> None:
        self._channels: dict[tuple[str, str], Channel] = {}
        self._messages: dict[tuple[str, str], list[Message]] = {}
        self._turns: dict[tuple[str, str], Turn] = {}
        self._turn_events: dict[tuple[str, str], list[TurnEvent]] = {}
        self._turn_chunks: dict[tuple[str, str], list[tuple[int, str, datetime]]] = {}
        self._bots: dict[tuple[str, str], Bot] = {}
        self._computers: dict[tuple[str, str], Computer] = {}
        self._logical_enqueue_ids: dict[tuple[str, str], set[str]] = {}
        self._lock = threading.Lock()

    def put_channel(self, channel: Channel) -> None:
        self._channels[(channel.tenant_id, channel.channel_id)] = channel

    def get_channel(self, tenant_id: str, channel_id: str) -> Channel | None:
        return self._channels.get((tenant_id, channel_id))

    def resolve_channel_tenant(self, channel_id: str) -> str | None:
        for (tenant_id, stored_channel_id), _ in self._channels.items():
            if stored_channel_id == channel_id:
                return tenant_id
        return None

    def put_message(self, message: Message) -> None:
        key = (message.tenant_id, message.channel_id)
        self._messages.setdefault(key, []).append(message)

    def list_messages(
        self, tenant_id: str, channel_id: str, after_seq: int = 0
    ) -> list[Message]:
        messages = self._messages.get((tenant_id, channel_id), [])
        return [message for message in messages if message.seq > after_seq]

    def put_turn(self, turn: Turn, *, expected_fence: int | None = None) -> None:
        with self._lock:
            if expected_fence is not None:
                current = self._turns.get((turn.tenant_id, turn.turn_id))
                if current is None or current.fence_token != expected_fence:
                    raise StaleAttemptError(
                        f"Turn {turn.turn_id!r} rejected a write for fence "
                        f"{expected_fence}."
                    )
            self._turns[(turn.tenant_id, turn.turn_id)] = turn

    def claim_turn_attempt(
        self,
        tenant_id: str,
        turn_id: str,
        worker_id: str,
        attempt_id: str,
        now: datetime,
        lease_expires_at: datetime,
    ) -> tuple[Turn, bool] | None:
        with self._lock:
            turn = self._turns.get((tenant_id, turn_id))
            if turn is None or turn.status != TurnStatus.ACTIVE:
                return None
            lease_valid = (
                turn.lease_expires_at is not None and turn.lease_expires_at > now
            )
            if lease_valid and turn.claimed_by_worker_id == worker_id:
                return turn, False
            if lease_valid and turn.claimed_by_worker_id != worker_id:
                return None
            turn.attempt_id = attempt_id
            turn.fence_token += 1
            turn.claimed_by_worker_id = worker_id
            turn.lease_expires_at = lease_expires_at
            return turn, True

    def renew_turn_lease(
        self,
        tenant_id: str,
        turn_id: str,
        worker_id: str,
        fence_token: int,
        lease_expires_at: datetime,
    ) -> Turn | None:
        with self._lock:
            turn = self._turns.get((tenant_id, turn_id))
            if (
                turn is None
                or turn.fence_token != fence_token
                or turn.claimed_by_worker_id != worker_id
            ):
                return None
            turn.lease_expires_at = lease_expires_at
            return turn

    def put_turn_event(self, event: TurnEvent) -> None:
        key = (event.tenant_id, event.turn_id)
        self._turn_events.setdefault(key, []).append(event)

    def list_turn_events(
        self, tenant_id: str, turn_id: str, after_seq: int = 0
    ) -> list[TurnEvent]:
        events = self._turn_events.get((tenant_id, turn_id), [])
        return [event for event in events if event.seq > after_seq]

    def put_turn_chunk(
        self,
        tenant_id: str,
        turn_id: str,
        chunk_seq: int,
        token: str,
        expires_at: datetime,
    ) -> bool:
        key = (tenant_id, turn_id)
        chunks = self._turn_chunks.setdefault(key, [])
        for existing_seq, existing_token, _ in chunks:
            if existing_seq == chunk_seq:
                if existing_token == token:
                    return False
                raise StaleAttemptError(
                    f"Turn {turn_id!r} rejected duplicate chunk seq {chunk_seq}."
                )
        chunks.append((chunk_seq, token, expires_at))
        return True

    def list_turn_chunks(self, tenant_id: str, turn_id: str) -> list[str]:
        chunks = self._turn_chunks.get((tenant_id, turn_id), [])
        ordered = sorted(chunks, key=lambda item: item[0])
        return [token for _, token, _ in ordered]

    def get_turn(self, tenant_id: str, turn_id: str) -> Turn | None:
        return self._turns.get((tenant_id, turn_id))

    def put_bot(self, bot: Bot) -> None:
        self._bots[(bot.tenant_id, bot.bot_id)] = bot

    def get_bot(self, tenant_id: str, bot_id: str) -> Bot | None:
        return self._bots.get((tenant_id, bot_id))

    def put_computer(self, computer: Computer) -> None:
        self._computers[(computer.tenant_id, computer.user_id)] = computer

    def get_computer(self, tenant_id: str, user_id: str) -> Computer | None:
        return self._computers.get((tenant_id, user_id))

    def record_logical_enqueue(
        self, tenant_id: str, turn_id: str, enqueue_id: str
    ) -> bool:
        key = (tenant_id, turn_id)
        with self._lock:
            recorded = self._logical_enqueue_ids.setdefault(key, set())
            if enqueue_id in recorded:
                return False
            recorded.add(enqueue_id)
            return True


class DynamoMessagingStore:
    """DynamoDB-backed store. Tests use moto; production uses a CDK table."""

    def __init__(
        self,
        table_name: str,
        *,
        client: Any | None = None,
        chunk_ttl_hours: int = 4,
    ) -> None:
        import boto3

        self.table_name = table_name
        self.client = client or boto3.client("dynamodb")
        self.chunk_ttl_hours = chunk_ttl_hours

    def put_channel(self, channel: Channel) -> None:
        self.client.put_item(
            TableName=self.table_name,
            Item={
                "pk": {"S": self._channel_pk(channel.tenant_id, channel.channel_id)},
                "sk": {"S": "meta"},
                "tenant_id": {"S": channel.tenant_id},
                "channel_id": {"S": channel.channel_id},
                "user_id": {"S": channel.user_id},
                "next_seq": {"N": str(channel.next_seq)},
                "participants": {"S": json.dumps(_participants_payload(channel))},
            },
        )
        self.client.put_item(
            TableName=self.table_name,
            Item={
                "pk": {"S": self._channel_lookup_pk(channel.channel_id)},
                "sk": {"S": "meta"},
                "tenant_id": {"S": channel.tenant_id},
                "channel_id": {"S": channel.channel_id},
            },
        )

    def get_channel(self, tenant_id: str, channel_id: str) -> Channel | None:
        response = self.client.get_item(
            TableName=self.table_name,
            Key={
                "pk": {"S": self._channel_pk(tenant_id, channel_id)},
                "sk": {"S": "meta"},
            },
        )
        item = response.get("Item")
        if item is None:
            return None
        participants = [
            ChannelParticipant(kind=ActorKind(row["kind"]), actor_id=row["actor_id"])
            for row in json.loads(item["participants"]["S"])
        ]
        return Channel(
            channel_id=item["channel_id"]["S"],
            tenant_id=item["tenant_id"]["S"],
            user_id=item["user_id"]["S"],
            participants=participants,
            next_seq=int(item["next_seq"]["N"]),
        )

    def resolve_channel_tenant(self, channel_id: str) -> str | None:
        response = self.client.get_item(
            TableName=self.table_name,
            Key={
                "pk": {"S": self._channel_lookup_pk(channel_id)},
                "sk": {"S": "meta"},
            },
        )
        item = response.get("Item")
        if item is None:
            return None
        return item["tenant_id"]["S"]

    def put_message(self, message: Message) -> None:
        self.client.put_item(
            TableName=self.table_name,
            Item={
                "pk": {"S": self._channel_pk(message.tenant_id, message.channel_id)},
                "sk": {"S": f"msg#{message.seq:010d}"},
                "tenant_id": {"S": message.tenant_id},
                "channel_id": {"S": message.channel_id},
                "message_id": {"S": message.message_id},
                "seq": {"N": str(message.seq)},
                "author_kind": {"S": message.author_kind},
                "author_id": {"S": message.author_id},
                "body": {"S": message.body},
                "addressed_to_bot_id": {"S": message.addressed_to_bot_id or ""},
                "created_at": {"S": message.created_at.isoformat()},
            },
        )

    def list_messages(
        self, tenant_id: str, channel_id: str, after_seq: int = 0
    ) -> list[Message]:
        response = self.client.query(
            TableName=self.table_name,
            KeyConditionExpression="pk = :pk AND sk > :sk",
            ExpressionAttributeValues={
                ":pk": {"S": self._channel_pk(tenant_id, channel_id)},
                ":sk": {"S": f"msg#{after_seq:010d}"},
            },
        )
        messages: list[Message] = []
        for item in response.get("Items", []):
            if not item["sk"]["S"].startswith("msg#"):
                continue
            messages.append(_message_from_item(item))
        return sorted(messages, key=lambda message: message.seq)

    def put_turn(self, turn: Turn, *, expected_fence: int | None = None) -> None:
        item = _turn_item(turn)
        kwargs: dict[str, Any] = {
            "TableName": self.table_name,
            "Item": item,
        }
        if expected_fence is not None:
            kwargs["ConditionExpression"] = "fence_token = :fence"
            kwargs["ExpressionAttributeValues"] = {":fence": {"N": str(expected_fence)}}
        try:
            self.client.put_item(**kwargs)
        except Exception as error:
            if getattr(error, "response", {}).get("Error", {}).get("Code") == (
                "ConditionalCheckFailedException"
            ):
                raise StaleAttemptError(
                    f"Turn {turn.turn_id!r} rejected a write for fence "
                    f"{expected_fence}."
                ) from error
            raise

    def get_turn(self, tenant_id: str, turn_id: str) -> Turn | None:
        response = self.client.get_item(
            TableName=self.table_name,
            Key={
                "pk": {"S": self._turn_pk(tenant_id, turn_id)},
                "sk": {"S": "meta"},
            },
        )
        item = response.get("Item")
        if item is None:
            return None
        return _turn_from_item(item)

    def claim_turn_attempt(
        self,
        tenant_id: str,
        turn_id: str,
        worker_id: str,
        attempt_id: str,
        now: datetime,
        lease_expires_at: datetime,
    ) -> tuple[Turn, bool] | None:
        current = self.get_turn(tenant_id, turn_id)
        if current is None or current.status != TurnStatus.ACTIVE:
            return None
        lease_valid = (
            current.lease_expires_at is not None and current.lease_expires_at > now
        )
        if lease_valid and current.claimed_by_worker_id == worker_id:
            return current, False
        if lease_valid and current.claimed_by_worker_id != worker_id:
            return None
        now_epoch = str(int(now.timestamp()))
        new_fence = current.fence_token + 1
        try:
            self.client.update_item(
                TableName=self.table_name,
                Key={
                    "pk": {"S": self._turn_pk(tenant_id, turn_id)},
                    "sk": {"S": "meta"},
                },
                UpdateExpression=(
                    "SET attempt_id = :aid, fence_token = :fence, "
                    "claimed_by_worker_id = :wid, lease_expires_at = :lease"
                ),
                ConditionExpression=(
                    "tenant_id = :tid AND #st = :active AND fence_token = :old_fence "
                    "AND (attribute_not_exists(lease_expires_at) "
                    "OR lease_expires_at <= :now)"
                ),
                ExpressionAttributeNames={"#st": "status"},
                ExpressionAttributeValues={
                    ":aid": {"S": attempt_id},
                    ":fence": {"N": str(new_fence)},
                    ":wid": {"S": worker_id},
                    ":lease": {"N": str(int(lease_expires_at.timestamp()))},
                    ":tid": {"S": tenant_id},
                    ":active": {"S": TurnStatus.ACTIVE},
                    ":old_fence": {"N": str(current.fence_token)},
                    ":now": {"N": now_epoch},
                },
            )
        except Exception as error:
            if getattr(error, "response", {}).get("Error", {}).get("Code") == (
                "ConditionalCheckFailedException"
            ):
                return None
            raise
        updated = self.get_turn(tenant_id, turn_id)
        if updated is None:
            return None
        return updated, True

    def renew_turn_lease(
        self,
        tenant_id: str,
        turn_id: str,
        worker_id: str,
        fence_token: int,
        lease_expires_at: datetime,
    ) -> Turn | None:
        try:
            self.client.update_item(
                TableName=self.table_name,
                Key={
                    "pk": {"S": self._turn_pk(tenant_id, turn_id)},
                    "sk": {"S": "meta"},
                },
                UpdateExpression="SET lease_expires_at = :lease",
                ConditionExpression=(
                    "tenant_id = :tid AND fence_token = :fence "
                    "AND claimed_by_worker_id = :wid"
                ),
                ExpressionAttributeValues={
                    ":lease": {"N": str(int(lease_expires_at.timestamp()))},
                    ":tid": {"S": tenant_id},
                    ":fence": {"N": str(fence_token)},
                    ":wid": {"S": worker_id},
                },
            )
        except Exception as error:
            if getattr(error, "response", {}).get("Error", {}).get("Code") == (
                "ConditionalCheckFailedException"
            ):
                return None
            raise
        return self.get_turn(tenant_id, turn_id)

    def put_turn_event(self, event: TurnEvent) -> None:
        item: dict[str, Any] = {
            "pk": {"S": self._turn_pk(event.tenant_id, event.turn_id)},
            "sk": {"S": f"evt#{event.seq:010d}"},
            "tenant_id": {"S": event.tenant_id},
            "turn_id": {"S": event.turn_id},
            "channel_id": {"S": event.channel_id},
            "event_id": {"S": event.event_id},
            "seq": {"N": str(event.seq)},
            "kind": {"S": event.kind},
            "token": {"S": event.token or ""},
            "message_seq": {"N": str(event.message_seq or 0)},
            "body": {"S": event.body or ""},
        }
        if event.pending_computer_tool is not None:
            item["pending_computer_tool"] = {
                "S": json.dumps(
                    {
                        "action_id": event.pending_computer_tool.action_id,
                        "tool_name": event.pending_computer_tool.tool_name,
                        "arguments": event.pending_computer_tool.arguments,
                    },
                    separators=(",", ":"),
                    sort_keys=True,
                )
            }
        self.client.put_item(
            TableName=self.table_name,
            Item=item,
        )

    def list_turn_events(
        self, tenant_id: str, turn_id: str, after_seq: int = 0
    ) -> list[TurnEvent]:
        response = self.client.query(
            TableName=self.table_name,
            KeyConditionExpression="pk = :pk AND sk > :sk",
            ExpressionAttributeValues={
                ":pk": {"S": self._turn_pk(tenant_id, turn_id)},
                ":sk": {"S": f"evt#{after_seq:010d}"},
            },
        )
        events: list[TurnEvent] = []
        for item in response.get("Items", []):
            if not item["sk"]["S"].startswith("evt#"):
                continue
            events.append(_turn_event_from_item(item))
        return sorted(events, key=lambda event: event.seq)

    def put_turn_chunk(
        self,
        tenant_id: str,
        turn_id: str,
        chunk_seq: int,
        token: str,
        expires_at: datetime,
    ) -> bool:
        response = self.client.query(
            TableName=self.table_name,
            KeyConditionExpression="pk = :pk AND sk = :sk",
            ExpressionAttributeValues={
                ":pk": {"S": self._turn_pk(tenant_id, turn_id)},
                ":sk": {"S": f"chunk#{chunk_seq:010d}"},
            },
        )
        items = response.get("Items", [])
        if items:
            existing = items[0]["token"]["S"]
            if existing == token:
                return False
            raise StaleAttemptError(
                f"Turn {turn_id!r} rejected duplicate chunk seq {chunk_seq}."
            )
        self.client.put_item(
            TableName=self.table_name,
            Item={
                "pk": {"S": self._turn_pk(tenant_id, turn_id)},
                "sk": {"S": f"chunk#{chunk_seq:010d}"},
                "tenant_id": {"S": tenant_id},
                "turn_id": {"S": turn_id},
                "token": {"S": token},
                "expires_at": {"N": str(int(expires_at.timestamp()))},
            },
        )
        return True

    def list_turn_chunks(self, tenant_id: str, turn_id: str) -> list[str]:
        response = self.client.query(
            TableName=self.table_name,
            KeyConditionExpression="pk = :pk AND begins_with(sk, :prefix)",
            ExpressionAttributeValues={
                ":pk": {"S": self._turn_pk(tenant_id, turn_id)},
                ":prefix": {"S": "chunk#"},
            },
        )
        chunks: list[tuple[int, str]] = []
        for item in response.get("Items", []):
            seq = int(item["sk"]["S"].split("#", 1)[1])
            chunks.append((seq, item["token"]["S"]))
        return [token for _, token in sorted(chunks, key=lambda pair: pair[0])]

    def put_bot(self, bot: Bot) -> None:
        self.client.put_item(
            TableName=self.table_name,
            Item={
                "pk": {"S": self._roster_pk(bot.tenant_id)},
                "sk": {"S": f"bot#{bot.bot_id}"},
                "tenant_id": {"S": bot.tenant_id},
                "user_id": {"S": bot.user_id},
                "bot_id": {"S": bot.bot_id},
                "name": {"S": bot.name},
            },
        )

    def get_bot(self, tenant_id: str, bot_id: str) -> Bot | None:
        response = self.client.get_item(
            TableName=self.table_name,
            Key={
                "pk": {"S": self._roster_pk(tenant_id)},
                "sk": {"S": f"bot#{bot_id}"},
            },
        )
        item = response.get("Item")
        if item is None:
            return None
        return Bot(
            bot_id=item["bot_id"]["S"],
            tenant_id=item["tenant_id"]["S"],
            user_id=item["user_id"]["S"],
            name=item["name"]["S"],
        )

    def put_computer(self, computer: Computer) -> None:
        self.client.put_item(
            TableName=self.table_name,
            Item={
                "pk": {"S": self._roster_pk(computer.tenant_id)},
                "sk": {"S": f"computer#{computer.user_id}"},
                "tenant_id": {"S": computer.tenant_id},
                "user_id": {"S": computer.user_id},
                "computer_id": {"S": computer.computer_id},
                "stopped": {"BOOL": computer.stopped},
                "policy": {"S": computer.policy},
            },
        )

    def get_computer(self, tenant_id: str, user_id: str) -> Computer | None:
        response = self.client.get_item(
            TableName=self.table_name,
            Key={
                "pk": {"S": self._roster_pk(tenant_id)},
                "sk": {"S": f"computer#{user_id}"},
            },
        )
        item = response.get("Item")
        if item is None:
            return None
        return Computer(
            computer_id=item["computer_id"]["S"],
            tenant_id=item["tenant_id"]["S"],
            user_id=item["user_id"]["S"],
            policy=ComputerPolicy(item["policy"]["S"]),
            stopped=item["stopped"]["BOOL"],
        )

    def record_logical_enqueue(
        self, tenant_id: str, turn_id: str, enqueue_id: str
    ) -> bool:
        try:
            self.client.update_item(
                TableName=self.table_name,
                Key={
                    "pk": {"S": self._turn_pk(tenant_id, turn_id)},
                    "sk": {"S": "meta"},
                },
                UpdateExpression="ADD logical_enqueue_ids :enqueue_id",
                ConditionExpression=(
                    "attribute_not_exists(logical_enqueue_ids) "
                    "OR NOT contains(logical_enqueue_ids, :enqueue_id_value)"
                ),
                ExpressionAttributeValues={
                    ":enqueue_id": {"SS": [enqueue_id]},
                    ":enqueue_id_value": {"S": enqueue_id},
                },
            )
        except Exception as error:
            if getattr(error, "response", {}).get("Error", {}).get("Code") == (
                "ConditionalCheckFailedException"
            ):
                return False
            raise
        return True

    def _channel_pk(self, tenant_id: str, channel_id: str) -> str:
        return f"{tenant_id}#channel#{channel_id}"

    def _channel_lookup_pk(self, channel_id: str) -> str:
        return f"channel_lookup#{channel_id}"

    def _turn_pk(self, tenant_id: str, turn_id: str) -> str:
        return f"{tenant_id}#turn#{turn_id}"

    def _roster_pk(self, tenant_id: str) -> str:
        return f"{tenant_id}#roster"


def _participants_payload(channel: Channel) -> list[dict[str, str]]:
    return [
        {"kind": participant.kind, "actor_id": participant.actor_id}
        for participant in channel.participants
    ]


def _message_from_item(item: dict[str, Any]) -> Message:
    addressed = item["addressed_to_bot_id"]["S"]
    return Message(
        message_id=item["message_id"]["S"],
        channel_id=item["channel_id"]["S"],
        tenant_id=item["tenant_id"]["S"],
        seq=int(item["seq"]["N"]),
        author_kind=ActorKind(item["author_kind"]["S"]),
        author_id=item["author_id"]["S"],
        body=item["body"]["S"],
        addressed_to_bot_id=addressed or None,
        created_at=datetime.fromisoformat(item["created_at"]["S"]),
    )


def _turn_item(turn: Turn) -> dict[str, Any]:
    item: dict[str, Any] = {
        "pk": {"S": f"{turn.tenant_id}#turn#{turn.turn_id}"},
        "sk": {"S": "meta"},
        "tenant_id": {"S": turn.tenant_id},
        "turn_id": {"S": turn.turn_id},
        "channel_id": {"S": turn.channel_id},
        "bot_id": {"S": turn.bot_id},
        "status": {"S": turn.status},
        "next_event_seq": {"N": str(turn.next_event_seq)},
        "next_chunk_seq": {"N": str(turn.next_chunk_seq)},
        "fence_token": {"N": str(turn.fence_token)},
    }
    if turn.attempt_id is not None:
        item["attempt_id"] = {"S": turn.attempt_id}
    if turn.claimed_by_worker_id is not None:
        item["claimed_by_worker_id"] = {"S": turn.claimed_by_worker_id}
    if turn.lease_expires_at is not None:
        item["lease_expires_at"] = {"N": str(int(turn.lease_expires_at.timestamp()))}
    if turn.deadline_at is not None:
        item["deadline_at"] = {"N": str(int(turn.deadline_at.timestamp()))}
    item["recovery_attempts"] = {"N": str(turn.recovery_attempts)}
    if turn.terminal_reason is not None:
        item["terminal_reason"] = {"S": turn.terminal_reason}
    if turn.ambiguous_provider_call_id is not None:
        item["ambiguous_provider_call_id"] = {"S": turn.ambiguous_provider_call_id}
    if turn.waiting_for is not None:
        item["waiting_for"] = {"S": turn.waiting_for}
    if turn.pending_computer_action_id is not None:
        item["pending_computer_action_id"] = {"S": turn.pending_computer_action_id}
    if turn.pending_computer_tool_name is not None:
        item["pending_computer_tool_name"] = {"S": turn.pending_computer_tool_name}
    return item


def _turn_from_item(item: dict[str, Any]) -> Turn:
    lease_item = item.get("lease_expires_at", {}).get("N")
    lease_expires_at = (
        datetime.fromtimestamp(int(lease_item), tz=UTC) if lease_item else None
    )
    attempt = item.get("attempt_id", {}).get("S") or None
    claimed = item.get("claimed_by_worker_id", {}).get("S") or None
    deadline_item = item.get("deadline_at", {}).get("N")
    deadline_at = (
        datetime.fromtimestamp(int(deadline_item), tz=UTC) if deadline_item else None
    )
    return Turn(
        turn_id=item["turn_id"]["S"],
        tenant_id=item["tenant_id"]["S"],
        channel_id=item["channel_id"]["S"],
        bot_id=item["bot_id"]["S"],
        status=TurnStatus(item["status"]["S"]),
        next_event_seq=int(item["next_event_seq"]["N"]),
        next_chunk_seq=int(item.get("next_chunk_seq", {}).get("N", "1")),
        attempt_id=attempt,
        fence_token=int(item.get("fence_token", {}).get("N", "0")),
        claimed_by_worker_id=claimed,
        lease_expires_at=lease_expires_at,
        deadline_at=deadline_at,
        recovery_attempts=int(item.get("recovery_attempts", {}).get("N", "0")),
        terminal_reason=item.get("terminal_reason", {}).get("S") or None,
        ambiguous_provider_call_id=(
            item.get("ambiguous_provider_call_id", {}).get("S") or None
        ),
        waiting_for=item.get("waiting_for", {}).get("S") or None,
        pending_computer_action_id=(
            item.get("pending_computer_action_id", {}).get("S") or None
        ),
        pending_computer_tool_name=(
            item.get("pending_computer_tool_name", {}).get("S") or None
        ),
    )


def _turn_event_from_item(item: dict[str, Any]) -> TurnEvent:
    message_seq = int(item["message_seq"]["N"])
    token = item["token"]["S"]
    body = item["body"]["S"]
    pending_raw = item.get("pending_computer_tool", {}).get("S")
    pending = None
    if pending_raw:
        payload = json.loads(pending_raw)
        pending = PendingComputerToolSnapshot(
            action_id=payload["action_id"],
            tool_name=payload["tool_name"],
            arguments=dict(payload["arguments"]),
        )
    return TurnEvent(
        event_id=item["event_id"]["S"],
        tenant_id=item["tenant_id"]["S"],
        turn_id=item["turn_id"]["S"],
        channel_id=item["channel_id"]["S"],
        seq=int(item["seq"]["N"]),
        kind=TurnEventKind(item["kind"]["S"]),
        token=token or None,
        message_seq=message_seq or None,
        body=body or None,
        pending_computer_tool=pending,
    )


def create_messaging_table(client: Any, table_name: str) -> None:
    """Create the messaging table shape used by moto tests."""
    client.create_table(
        TableName=table_name,
        KeySchema=[
            {"AttributeName": "pk", "KeyType": "HASH"},
            {"AttributeName": "sk", "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": "pk", "AttributeType": "S"},
            {"AttributeName": "sk", "AttributeType": "S"},
        ],
        BillingMode="PAY_PER_REQUEST",
    )


def default_chunk_expiry(now: datetime, hours: int = 4) -> datetime:
    """Return a TTL timestamp for in-flight chunks."""
    return now + timedelta(hours=hours)
