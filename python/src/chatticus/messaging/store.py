"""Durable channel, message, turn event, and chunk persistence."""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Any, Protocol

from chatticus.models import (
    ActorKind,
    Bot,
    Channel,
    ChannelParticipant,
    Computer,
    ComputerPolicy,
    Message,
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

    def put_message(self, message: Message) -> None:
        """Persist one committed message row."""

    def list_messages(
        self, tenant_id: str, channel_id: str, after_seq: int = 0
    ) -> list[Message]:
        """Return messages with seq greater than after_seq."""

    def put_turn(self, turn: Turn) -> None:
        """Persist turn metadata."""

    def get_turn(self, tenant_id: str, turn_id: str) -> Turn | None:
        """Load one turn."""

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
    ) -> None:
        """Persist one in-flight chunk with TTL metadata."""

    def list_turn_chunks(self, tenant_id: str, turn_id: str) -> list[str]:
        """Return chunk tokens in order."""


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

    def put_channel(self, channel: Channel) -> None:
        self._channels[(channel.tenant_id, channel.channel_id)] = channel

    def get_channel(self, tenant_id: str, channel_id: str) -> Channel | None:
        return self._channels.get((tenant_id, channel_id))

    def put_message(self, message: Message) -> None:
        key = (message.tenant_id, message.channel_id)
        self._messages.setdefault(key, []).append(message)

    def list_messages(
        self, tenant_id: str, channel_id: str, after_seq: int = 0
    ) -> list[Message]:
        messages = self._messages.get((tenant_id, channel_id), [])
        return [message for message in messages if message.seq > after_seq]

    def put_turn(self, turn: Turn) -> None:
        self._turns[(turn.tenant_id, turn.turn_id)] = turn

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
    ) -> None:
        key = (tenant_id, turn_id)
        self._turn_chunks.setdefault(key, []).append((chunk_seq, token, expires_at))

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

    def put_turn(self, turn: Turn) -> None:
        self.client.put_item(
            TableName=self.table_name,
            Item={
                "pk": {"S": self._turn_pk(turn.tenant_id, turn.turn_id)},
                "sk": {"S": "meta"},
                "tenant_id": {"S": turn.tenant_id},
                "turn_id": {"S": turn.turn_id},
                "channel_id": {"S": turn.channel_id},
                "bot_id": {"S": turn.bot_id},
                "status": {"S": turn.status},
                "next_event_seq": {"N": str(turn.next_event_seq)},
                "next_chunk_seq": {"N": str(turn.next_chunk_seq)},
            },
        )

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
        return Turn(
            turn_id=item["turn_id"]["S"],
            tenant_id=item["tenant_id"]["S"],
            channel_id=item["channel_id"]["S"],
            bot_id=item["bot_id"]["S"],
            status=TurnStatus(item["status"]["S"]),
            next_event_seq=int(item["next_event_seq"]["N"]),
            next_chunk_seq=int(item.get("next_chunk_seq", {}).get("N", "1")),
        )

    def put_turn_event(self, event: TurnEvent) -> None:
        self.client.put_item(
            TableName=self.table_name,
            Item={
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
            },
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
    ) -> None:
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

    def _channel_pk(self, tenant_id: str, channel_id: str) -> str:
        return f"{tenant_id}#channel#{channel_id}"

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


def _turn_event_from_item(item: dict[str, Any]) -> TurnEvent:
    message_seq = int(item["message_seq"]["N"])
    token = item["token"]["S"]
    body = item["body"]["S"]
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
