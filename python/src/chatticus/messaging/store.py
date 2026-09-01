"""Durable channel, message, turn event, and chunk persistence."""

from __future__ import annotations

import json
import threading
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from chatticus.capability_policy import (
    TaskCapabilityGrant,
    grant_from_payload,
    grant_to_payload,
)
from chatticus.models import (
    ActorKind,
    Bot,
    Channel,
    ChannelParticipant,
    Computer,
    ComputerPolicy,
    DuplicateBotNameError,
    Identity,
    Invitation,
    InvitationStatus,
    MemberRole,
    Membership,
    Message,
    Organization,
    OrganizationStatus,
    PendingComputerToolSnapshot,
    StaleAttemptError,
    Task,
    TaskStatus,
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

    def list_channels(self, tenant_id: str, user_id: str) -> list[Channel]:
        """Return channels owned by one household user."""

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

    def get_active_turn(self, tenant_id: str, channel_id: str) -> Turn | None:
        """Return the active turn on a channel, if any."""

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

    def put_bot(self, bot: Bot, *, reserve_name: bool = False) -> None:
        """Persist a named bot.

        When ``reserve_name`` is true, atomically claim the user's bot name.
        """

    def get_bot(self, tenant_id: str, bot_id: str) -> Bot | None:
        """Load one bot."""

    def get_bot_by_name(self, tenant_id: str, user_id: str, name: str) -> Bot | None:
        """Load one bot by the household user's chosen name."""

    def list_bots(self, tenant_id: str, user_id: str) -> list[Bot]:
        """Return named bots owned by one household user."""

    def put_computer(self, computer: Computer) -> None:
        """Persist the household computer record."""

    def get_computer(self, tenant_id: str, user_id: str) -> Computer | None:
        """Load the household computer for a user."""

    def claim_host_start_dispatch(
        self, tenant_id: str, user_id: str, generation: int
    ) -> bool:
        """Return True when this caller first claims host start for generation."""

    def release_host_start_dispatch(
        self, tenant_id: str, user_id: str, generation: int
    ) -> None:
        """Allow another worker to dispatch the same generation after RunTask failed."""

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

    def get_post_idempotency(
        self, tenant_id: str, idempotency_key: str
    ) -> tuple[Message, str | None] | None:
        """Return the message and turn stored for one post idempotency key."""

    def put_post_idempotency(
        self,
        tenant_id: str,
        idempotency_key: str,
        message: Message,
        turn_id: str | None,
    ) -> None:
        """Persist the result of one idempotent channel post."""

    def get_channel_idempotency(
        self, tenant_id: str, idempotency_key: str
    ) -> Channel | None:
        """Return the channel stored for one create-channel idempotency key."""

    def put_channel_idempotency(
        self,
        tenant_id: str,
        idempotency_key: str,
        channel: Channel,
    ) -> None:
        """Persist the result of one idempotent channel create."""

    def get_bot_idempotency(self, tenant_id: str, idempotency_key: str) -> Bot | None:
        """Return the bot stored for one create-bot idempotency key."""

    def put_bot_idempotency(
        self,
        tenant_id: str,
        idempotency_key: str,
        bot: Bot,
    ) -> None:
        """Persist the result of one idempotent bot create."""

    def put_task(self, task: Task) -> None:
        """Persist one Task item."""

    def get_task(self, tenant_id: str, task_id: str) -> Task | None:
        """Load one Task item."""

    def list_tasks(self, tenant_id: str, user_id: str) -> list[Task]:
        """Return tasks owned by one household user."""

    def put_turn_capability_grant(
        self, tenant_id: str, turn_id: str, grant: TaskCapabilityGrant
    ) -> None:
        """Persist the closed task grant for one turn."""

    def get_turn_capability_grant(
        self, tenant_id: str, turn_id: str
    ) -> TaskCapabilityGrant | None:
        """Load the task grant for one turn, if any."""

    def put_identity(self, identity: Identity) -> None:
        """Persist one global identity."""

    def get_identity_by_email(self, email: str) -> Identity | None:
        """Load one identity by normalized email."""

    def get_identity(self, user_id: str) -> Identity | None:
        """Load one identity by user id."""

    def put_organization(self, organization: Organization) -> None:
        """Persist one organization."""

    def get_organization(self, tenant_id: str) -> Organization | None:
        """Load one organization."""

    def put_membership(self, membership: Membership) -> None:
        """Persist one membership and its user-to-organization index."""

    def get_membership(self, tenant_id: str, user_id: str) -> Membership | None:
        """Load one membership."""

    def list_memberships(self, tenant_id: str) -> list[Membership]:
        """Return every membership in one organization."""

    def list_organizations_for_user(self, user_id: str) -> list[Organization]:
        """Return every organization one user belongs to."""

    def put_invitation(self, invitation: Invitation) -> None:
        """Persist one invitation and its lookup item."""

    def get_invitation(self, invitation_id: str) -> Invitation | None:
        """Load one invitation by id."""


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
        self._post_idempotency: dict[tuple[str, str], tuple[Message, str | None]] = {}
        self._channel_idempotency: dict[tuple[str, str], str] = {}
        self._bot_idempotency: dict[tuple[str, str], str] = {}
        self._tasks: dict[tuple[str, str], Task] = {}
        self._turn_grants: dict[tuple[str, str], TaskCapabilityGrant] = {}
        self._active_channel_turns: dict[tuple[str, str], str] = {}
        self._identities_by_email: dict[str, Identity] = {}
        self._identities_by_user: dict[str, Identity] = {}
        self._organizations: dict[str, Organization] = {}
        self._memberships: dict[tuple[str, str], Membership] = {}
        self._user_org_index: dict[tuple[str, str], Membership] = {}
        self._invitations: dict[str, Invitation] = {}
        self._lock = threading.Lock()

    def put_channel(self, channel: Channel) -> None:
        self._channels[(channel.tenant_id, channel.channel_id)] = channel

    def get_channel(self, tenant_id: str, channel_id: str) -> Channel | None:
        return self._channels.get((tenant_id, channel_id))

    def list_channels(self, tenant_id: str, user_id: str) -> list[Channel]:
        return sorted(
            (
                channel
                for channel in self._channels.values()
                if channel.tenant_id == tenant_id and channel.user_id == user_id
            ),
            key=lambda channel: channel.channel_id,
        )

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
            self._sync_active_channel_turn(turn)

    def _sync_active_channel_turn(self, turn: Turn) -> None:
        key = (turn.tenant_id, turn.channel_id)
        if turn.status == TurnStatus.ACTIVE:
            self._active_channel_turns[key] = turn.turn_id
            return
        if self._active_channel_turns.get(key) == turn.turn_id:
            del self._active_channel_turns[key]

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

    def get_active_turn(self, tenant_id: str, channel_id: str) -> Turn | None:
        turn_id = self._active_channel_turns.get((tenant_id, channel_id))
        if turn_id is None:
            return None
        turn = self.get_turn(tenant_id, turn_id)
        if turn is None or turn.status != TurnStatus.ACTIVE:
            return None
        return turn

    def put_bot(self, bot: Bot, *, reserve_name: bool = False) -> None:
        with self._lock:
            if reserve_name and self.get_bot_by_name(
                bot.tenant_id, bot.user_id, bot.name
            ):
                raise DuplicateBotNameError(
                    f"Bot named {bot.name!r} already exists for user "
                    f"{bot.user_id!r}."
                )
            self._bots[(bot.tenant_id, bot.bot_id)] = bot

    def get_bot(self, tenant_id: str, bot_id: str) -> Bot | None:
        return self._bots.get((tenant_id, bot_id))

    def get_bot_by_name(self, tenant_id: str, user_id: str, name: str) -> Bot | None:
        for bot in self._bots.values():
            if (
                bot.tenant_id == tenant_id
                and bot.user_id == user_id
                and bot.name == name
            ):
                return bot
        return None

    def list_bots(self, tenant_id: str, user_id: str) -> list[Bot]:
        return sorted(
            (
                bot
                for bot in self._bots.values()
                if bot.tenant_id == tenant_id and bot.user_id == user_id
            ),
            key=lambda bot: bot.name,
        )

    def put_computer(self, computer: Computer) -> None:
        self._computers[(computer.tenant_id, computer.user_id)] = computer

    def get_computer(self, tenant_id: str, user_id: str) -> Computer | None:
        return self._computers.get((tenant_id, user_id))

    def claim_host_start_dispatch(
        self, tenant_id: str, user_id: str, generation: int
    ) -> bool:
        with self._lock:
            computer = self._computers.get((tenant_id, user_id))
            if computer is None:
                return False
            if computer.host_start_dispatched_generation >= generation:
                return False
            computer.host_start_dispatched_generation = generation
            self._computers[(tenant_id, user_id)] = computer
            return True

    def release_host_start_dispatch(
        self, tenant_id: str, user_id: str, generation: int
    ) -> None:
        with self._lock:
            computer = self._computers.get((tenant_id, user_id))
            if computer is None:
                return
            if computer.host_start_dispatched_generation != generation:
                return
            computer.host_start_dispatched_generation = generation - 1
            self._computers[(tenant_id, user_id)] = computer

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

    def get_post_idempotency(
        self, tenant_id: str, idempotency_key: str
    ) -> tuple[Message, str | None] | None:
        return self._post_idempotency.get((tenant_id, idempotency_key))

    def put_post_idempotency(
        self,
        tenant_id: str,
        idempotency_key: str,
        message: Message,
        turn_id: str | None,
    ) -> None:
        self._post_idempotency[(tenant_id, idempotency_key)] = (message, turn_id)

    def get_channel_idempotency(
        self, tenant_id: str, idempotency_key: str
    ) -> Channel | None:
        channel_id = self._channel_idempotency.get((tenant_id, idempotency_key))
        if channel_id is None:
            return None
        return self.get_channel(tenant_id, channel_id)

    def put_channel_idempotency(
        self,
        tenant_id: str,
        idempotency_key: str,
        channel: Channel,
    ) -> None:
        self._channel_idempotency[(tenant_id, idempotency_key)] = channel.channel_id

    def get_bot_idempotency(self, tenant_id: str, idempotency_key: str) -> Bot | None:
        bot_id = self._bot_idempotency.get((tenant_id, idempotency_key))
        if bot_id is None:
            return None
        return self.get_bot(tenant_id, bot_id)

    def put_bot_idempotency(
        self,
        tenant_id: str,
        idempotency_key: str,
        bot: Bot,
    ) -> None:
        self._bot_idempotency[(tenant_id, idempotency_key)] = bot.bot_id

    def put_task(self, task: Task) -> None:
        self._tasks[(task.tenant_id, task.task_id)] = task

    def get_task(self, tenant_id: str, task_id: str) -> Task | None:
        return self._tasks.get((tenant_id, task_id))

    def list_tasks(self, tenant_id: str, user_id: str) -> list[Task]:
        return sorted(
            (
                task
                for task in self._tasks.values()
                if task.tenant_id == tenant_id and task.user_id == user_id
            ),
            key=lambda task: task.task_id,
        )

    def put_turn_capability_grant(
        self, tenant_id: str, turn_id: str, grant: TaskCapabilityGrant
    ) -> None:
        self._turn_grants[(tenant_id, turn_id)] = grant

    def get_turn_capability_grant(
        self, tenant_id: str, turn_id: str
    ) -> TaskCapabilityGrant | None:
        return self._turn_grants.get((tenant_id, turn_id))

    def put_identity(self, identity: Identity) -> None:
        self._identities_by_email[identity.email] = identity
        self._identities_by_user[identity.user_id] = identity

    def get_identity_by_email(self, email: str) -> Identity | None:
        return self._identities_by_email.get(email)

    def get_identity(self, user_id: str) -> Identity | None:
        return self._identities_by_user.get(user_id)

    def put_organization(self, organization: Organization) -> None:
        self._organizations[organization.tenant_id] = organization

    def get_organization(self, tenant_id: str) -> Organization | None:
        return self._organizations.get(tenant_id)

    def put_membership(self, membership: Membership) -> None:
        key = (membership.tenant_id, membership.user_id)
        self._memberships[key] = membership
        self._user_org_index[(membership.user_id, membership.tenant_id)] = membership

    def get_membership(self, tenant_id: str, user_id: str) -> Membership | None:
        return self._memberships.get((tenant_id, user_id))

    def list_memberships(self, tenant_id: str) -> list[Membership]:
        return sorted(
            (
                membership
                for membership in self._memberships.values()
                if membership.tenant_id == tenant_id
            ),
            key=lambda membership: membership.user_id,
        )

    def list_organizations_for_user(self, user_id: str) -> list[Organization]:
        organizations: list[Organization] = []
        for (indexed_user_id, tenant_id), _ in self._user_org_index.items():
            if indexed_user_id != user_id:
                continue
            organization = self.get_organization(tenant_id)
            if organization is not None:
                organizations.append(organization)
        return sorted(organizations, key=lambda organization: organization.tenant_id)

    def put_invitation(self, invitation: Invitation) -> None:
        self._invitations[invitation.invitation_id] = invitation

    def get_invitation(self, invitation_id: str) -> Invitation | None:
        return self._invitations.get(invitation_id)


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
        self.client.put_item(
            TableName=self.table_name,
            Item={
                "pk": {"S": self._roster_pk(channel.tenant_id)},
                "sk": {
                    "S": self._channel_roster_sk(channel.user_id, channel.channel_id)
                },
                "tenant_id": {"S": channel.tenant_id},
                "user_id": {"S": channel.user_id},
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

    def list_channels(self, tenant_id: str, user_id: str) -> list[Channel]:
        response = self.client.query(
            TableName=self.table_name,
            KeyConditionExpression="pk = :pk AND begins_with(sk, :prefix)",
            ExpressionAttributeValues={
                ":pk": {"S": self._roster_pk(tenant_id)},
                ":prefix": {"S": f"channel#{user_id}#"},
            },
        )
        channels: list[Channel] = []
        for row in response.get("Items", []):
            channel_id = row["channel_id"]["S"]
            channel = self.get_channel(tenant_id, channel_id)
            if channel is not None:
                channels.append(channel)
        return sorted(channels, key=lambda channel: channel.channel_id)

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
            Item=_message_item(
                message,
                pk=self._channel_pk(message.tenant_id, message.channel_id),
                sk=f"msg#{message.seq:010d}",
            ),
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

        self._sync_active_channel_turn(turn)

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

    def get_active_turn(self, tenant_id: str, channel_id: str) -> Turn | None:
        response = self.client.get_item(
            TableName=self.table_name,
            Key={
                "pk": {"S": self._channel_pk(tenant_id, channel_id)},
                "sk": {"S": "active_turn"},
            },
        )
        item = response.get("Item")
        if item is None:
            return None
        turn = self.get_turn(tenant_id, item["turn_id"]["S"])
        if turn is None or turn.status != TurnStatus.ACTIVE:
            return None
        return turn

    def _sync_active_channel_turn(self, turn: Turn) -> None:
        key = {
            "pk": {"S": self._channel_pk(turn.tenant_id, turn.channel_id)},
            "sk": {"S": "active_turn"},
        }
        if turn.status == TurnStatus.ACTIVE:
            self.client.put_item(
                TableName=self.table_name,
                Item={
                    **key,
                    "tenant_id": {"S": turn.tenant_id},
                    "channel_id": {"S": turn.channel_id},
                    "turn_id": {"S": turn.turn_id},
                },
            )
            return
        try:
            self.client.delete_item(
                TableName=self.table_name,
                Key=key,
                ConditionExpression="turn_id = :turn_id",
                ExpressionAttributeValues={":turn_id": {"S": turn.turn_id}},
            )
        except Exception as error:
            if getattr(error, "response", {}).get("Error", {}).get("Code") != (
                "ConditionalCheckFailedException"
            ):
                raise

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
        if event.action_id is not None:
            item["action_id"] = {"S": event.action_id}
        if event.attempt_id is not None:
            item["attempt_id"] = {"S": event.attempt_id}
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

    def put_bot(self, bot: Bot, *, reserve_name: bool = False) -> None:
        bot_item = {
            "pk": {"S": self._roster_pk(bot.tenant_id)},
            "sk": {"S": f"bot#{bot.bot_id}"},
            "tenant_id": {"S": bot.tenant_id},
            "user_id": {"S": bot.user_id},
            "bot_id": {"S": bot.bot_id},
            "name": {"S": bot.name},
            "memory": {"S": json.dumps(bot.memory)},
        }
        if not reserve_name:
            self.client.put_item(TableName=self.table_name, Item=bot_item)
            return
        name_item = {
            "pk": {"S": self._roster_pk(bot.tenant_id)},
            "sk": {"S": self._bot_name_sk(bot.user_id, bot.name)},
            "tenant_id": {"S": bot.tenant_id},
            "user_id": {"S": bot.user_id},
            "bot_id": {"S": bot.bot_id},
            "name": {"S": bot.name},
        }
        try:
            self.client.transact_write_items(
                TransactItems=[
                    {"Put": {"TableName": self.table_name, "Item": bot_item}},
                    {
                        "Put": {
                            "TableName": self.table_name,
                            "Item": name_item,
                            "ConditionExpression": "attribute_not_exists(pk)",
                        }
                    },
                ]
            )
        except self.client.exceptions.TransactionCanceledException as error:
            reasons = error.response.get("CancellationReasons", ())
            if any(
                reason.get("Code") == "ConditionalCheckFailed"
                for reason in reasons
                if isinstance(reason, dict)
            ):
                raise DuplicateBotNameError(
                    f"Bot named {bot.name!r} already exists for user "
                    f"{bot.user_id!r}."
                ) from error
            raise

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
        memory_raw = item.get("memory", {}).get("S", "{}")
        try:
            memory = json.loads(memory_raw)
        except json.JSONDecodeError:
            memory = {}
        if not isinstance(memory, dict):
            memory = {}
        return self._bot_from_item(item)

    def get_bot_by_name(self, tenant_id: str, user_id: str, name: str) -> Bot | None:
        response = self.client.get_item(
            TableName=self.table_name,
            Key={
                "pk": {"S": self._roster_pk(tenant_id)},
                "sk": {"S": self._bot_name_sk(user_id, name)},
            },
        )
        item = response.get("Item")
        if item is not None:
            return self.get_bot(tenant_id, item["bot_id"]["S"])
        response = self.client.query(
            TableName=self.table_name,
            KeyConditionExpression="pk = :pk AND begins_with(sk, :prefix)",
            ExpressionAttributeValues={
                ":pk": {"S": self._roster_pk(tenant_id)},
                ":prefix": {"S": "bot#"},
            },
        )
        for row in response.get("Items", []):
            if row["user_id"]["S"] == user_id and row["name"]["S"] == name:
                return self._bot_from_item(row)
        return None

    def list_bots(self, tenant_id: str, user_id: str) -> list[Bot]:
        response = self.client.query(
            TableName=self.table_name,
            KeyConditionExpression="pk = :pk AND begins_with(sk, :prefix)",
            ExpressionAttributeValues={
                ":pk": {"S": self._roster_pk(tenant_id)},
                ":prefix": {"S": "bot#"},
            },
        )
        bots: list[Bot] = []
        for row in response.get("Items", []):
            if row.get("user_id", {}).get("S") != user_id:
                continue
            bots.append(self._bot_from_item(row))
        return sorted(bots, key=lambda bot: bot.name)

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
                "model_ready": {"BOOL": computer.model_ready},
                "workspace_ready": {"BOOL": computer.workspace_ready},
                "browser_ready": {"BOOL": computer.browser_ready},
                "host_start_generation": {"N": str(computer.host_start_generation)},
                "host_start_dispatched_generation": {
                    "N": str(computer.host_start_dispatched_generation)
                },
                "host_start_lease_expires_at": {
                    "N": str(
                        int(computer.host_start_lease_expires_at.timestamp())
                        if computer.host_start_lease_expires_at is not None
                        else 0
                    )
                },
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
        lease_epoch = int(item.get("host_start_lease_expires_at", {}).get("N", "0"))
        return Computer(
            computer_id=item["computer_id"]["S"],
            tenant_id=item["tenant_id"]["S"],
            user_id=item["user_id"]["S"],
            policy=ComputerPolicy(item["policy"]["S"]),
            stopped=item["stopped"]["BOOL"],
            model_ready=item.get("model_ready", {}).get("BOOL", True),
            workspace_ready=item.get("workspace_ready", {}).get("BOOL", False),
            browser_ready=item.get("browser_ready", {}).get("BOOL", False),
            host_start_generation=int(
                item.get("host_start_generation", {}).get("N", "0")
            ),
            host_start_dispatched_generation=int(
                item.get("host_start_dispatched_generation", {}).get("N", "0")
            ),
            host_start_lease_expires_at=(
                datetime.fromtimestamp(lease_epoch, tz=UTC) if lease_epoch else None
            ),
        )

    def claim_host_start_dispatch(
        self, tenant_id: str, user_id: str, generation: int
    ) -> bool:
        try:
            self.client.update_item(
                TableName=self.table_name,
                Key={
                    "pk": {"S": self._roster_pk(tenant_id)},
                    "sk": {"S": f"computer#{user_id}"},
                },
                UpdateExpression="SET host_start_dispatched_generation = :gen",
                ConditionExpression=(
                    "attribute_exists(pk) AND "
                    "(attribute_not_exists(host_start_dispatched_generation) "
                    "OR host_start_dispatched_generation < :gen)"
                ),
                ExpressionAttributeValues={":gen": {"N": str(generation)}},
            )
        except Exception as error:
            if getattr(error, "response", {}).get("Error", {}).get("Code") == (
                "ConditionalCheckFailedException"
            ):
                return False
            raise
        return True

    def release_host_start_dispatch(
        self, tenant_id: str, user_id: str, generation: int
    ) -> None:
        try:
            self.client.update_item(
                TableName=self.table_name,
                Key={
                    "pk": {"S": self._roster_pk(tenant_id)},
                    "sk": {"S": f"computer#{user_id}"},
                },
                UpdateExpression="SET host_start_dispatched_generation = :prev",
                ConditionExpression=(
                    "attribute_exists(pk) AND host_start_dispatched_generation = :gen"
                ),
                ExpressionAttributeValues={
                    ":gen": {"N": str(generation)},
                    ":prev": {"N": str(max(generation - 1, 0))},
                },
            )
        except Exception as error:
            if getattr(error, "response", {}).get("Error", {}).get("Code") == (
                "ConditionalCheckFailedException"
            ):
                return
            raise

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

    def get_post_idempotency(
        self, tenant_id: str, idempotency_key: str
    ) -> tuple[Message, str | None] | None:
        response = self.client.get_item(
            TableName=self.table_name,
            Key={
                "pk": {"S": self._roster_pk(tenant_id)},
                "sk": {"S": f"idem#{idempotency_key}"},
            },
        )
        item = response.get("Item")
        if item is None:
            return None
        turn_id = item.get("turn_id", {}).get("S") or None
        return _message_from_item(item), turn_id

    def put_post_idempotency(
        self,
        tenant_id: str,
        idempotency_key: str,
        message: Message,
        turn_id: str | None,
    ) -> None:
        item = _message_item(
            message,
            pk=self._roster_pk(tenant_id),
            sk=f"idem#{idempotency_key}",
        )
        if turn_id is not None:
            item["turn_id"] = {"S": turn_id}
        self.client.put_item(TableName=self.table_name, Item=item)

    def get_channel_idempotency(
        self, tenant_id: str, idempotency_key: str
    ) -> Channel | None:
        response = self.client.get_item(
            TableName=self.table_name,
            Key={
                "pk": {"S": self._roster_pk(tenant_id)},
                "sk": {"S": f"chidem#{idempotency_key}"},
            },
        )
        item = response.get("Item")
        if item is None:
            return None
        channel_id = item.get("channel_id", {}).get("S")
        if not channel_id:
            return None
        return self.get_channel(tenant_id, channel_id)

    def put_channel_idempotency(
        self,
        tenant_id: str,
        idempotency_key: str,
        channel: Channel,
    ) -> None:
        self.client.put_item(
            TableName=self.table_name,
            Item={
                "pk": {"S": self._roster_pk(tenant_id)},
                "sk": {"S": f"chidem#{idempotency_key}"},
                "tenant_id": {"S": tenant_id},
                "channel_id": {"S": channel.channel_id},
            },
        )

    def get_bot_idempotency(self, tenant_id: str, idempotency_key: str) -> Bot | None:
        response = self.client.get_item(
            TableName=self.table_name,
            Key={
                "pk": {"S": self._roster_pk(tenant_id)},
                "sk": {"S": f"botidem#{idempotency_key}"},
            },
        )
        item = response.get("Item")
        if item is None:
            return None
        bot_id = item.get("bot_id", {}).get("S")
        if not bot_id:
            return None
        return self.get_bot(tenant_id, bot_id)

    def put_bot_idempotency(
        self,
        tenant_id: str,
        idempotency_key: str,
        bot: Bot,
    ) -> None:
        self.client.put_item(
            TableName=self.table_name,
            Item={
                "pk": {"S": self._roster_pk(tenant_id)},
                "sk": {"S": f"botidem#{idempotency_key}"},
                "tenant_id": {"S": tenant_id},
                "bot_id": {"S": bot.bot_id},
            },
        )

    def put_task(self, task: Task) -> None:
        self.client.put_item(
            TableName=self.table_name,
            Item=_task_item(task),
        )
        self.client.put_item(
            TableName=self.table_name,
            Item={
                "pk": {"S": self._roster_pk(task.tenant_id)},
                "sk": {"S": self._task_roster_sk(task.user_id, task.task_id)},
                "tenant_id": {"S": task.tenant_id},
                "user_id": {"S": task.user_id},
                "task_id": {"S": task.task_id},
            },
        )

    def get_task(self, tenant_id: str, task_id: str) -> Task | None:
        response = self.client.get_item(
            TableName=self.table_name,
            Key={
                "pk": {"S": self._task_pk(tenant_id, task_id)},
                "sk": {"S": "meta"},
            },
        )
        item = response.get("Item")
        if item is None:
            return None
        return _task_from_item(item)

    def list_tasks(self, tenant_id: str, user_id: str) -> list[Task]:
        response = self.client.query(
            TableName=self.table_name,
            KeyConditionExpression="pk = :pk AND begins_with(sk, :prefix)",
            ExpressionAttributeValues={
                ":pk": {"S": self._roster_pk(tenant_id)},
                ":prefix": {"S": f"task#{user_id}#"},
            },
        )
        tasks: list[Task] = []
        for row in response.get("Items", []):
            task_id = row["task_id"]["S"]
            task = self.get_task(tenant_id, task_id)
            if task is not None:
                tasks.append(task)
        return sorted(tasks, key=lambda task: task.task_id)

    def put_turn_capability_grant(
        self, tenant_id: str, turn_id: str, grant: TaskCapabilityGrant
    ) -> None:
        self.client.put_item(
            TableName=self.table_name,
            Item={
                "pk": {"S": self._turn_pk(tenant_id, turn_id)},
                "sk": {"S": "grant"},
                "tenant_id": {"S": tenant_id},
                "turn_id": {"S": turn_id},
                "grant": {
                    "S": json.dumps(
                        grant_to_payload(grant),
                        separators=(",", ":"),
                        sort_keys=True,
                    )
                },
            },
        )

    def get_turn_capability_grant(
        self, tenant_id: str, turn_id: str
    ) -> TaskCapabilityGrant | None:
        response = self.client.get_item(
            TableName=self.table_name,
            Key={
                "pk": {"S": self._turn_pk(tenant_id, turn_id)},
                "sk": {"S": "grant"},
            },
        )
        item = response.get("Item")
        if item is None:
            return None
        raw = item.get("grant", {}).get("S")
        if not raw:
            return None
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            return None
        return grant_from_payload(payload)

    def put_identity(self, identity: Identity) -> None:
        self.client.put_item(
            TableName=self.table_name,
            Item=_identity_item(identity),
        )
        self.client.put_item(
            TableName=self.table_name,
            Item={
                "pk": {"S": self._identity_lookup_pk(identity.email)},
                "sk": {"S": "meta"},
                "user_id": {"S": identity.user_id},
                "email": {"S": identity.email},
                "created_at": {"S": identity.created_at.isoformat()},
            },
        )

    def get_identity_by_email(self, email: str) -> Identity | None:
        response = self.client.get_item(
            TableName=self.table_name,
            Key={
                "pk": {"S": self._identity_lookup_pk(email)},
                "sk": {"S": "meta"},
            },
        )
        item = response.get("Item")
        if item is None:
            return None
        return self.get_identity(item["user_id"]["S"])

    def get_identity(self, user_id: str) -> Identity | None:
        response = self.client.get_item(
            TableName=self.table_name,
            Key={
                "pk": {"S": self._user_pk(user_id)},
                "sk": {"S": "identity"},
            },
        )
        item = response.get("Item")
        if item is None:
            return None
        return _identity_from_item(item)

    def put_organization(self, organization: Organization) -> None:
        self.client.put_item(
            TableName=self.table_name,
            Item=_organization_item(organization),
        )

    def get_organization(self, tenant_id: str) -> Organization | None:
        response = self.client.get_item(
            TableName=self.table_name,
            Key={
                "pk": {"S": self._org_pk(tenant_id)},
                "sk": {"S": "meta"},
            },
        )
        item = response.get("Item")
        if item is None:
            return None
        return _organization_from_item(item)

    def put_membership(self, membership: Membership) -> None:
        self.client.put_item(
            TableName=self.table_name,
            Item=_membership_item(membership),
        )
        self.client.put_item(
            TableName=self.table_name,
            Item={
                "pk": {"S": self._user_pk(membership.user_id)},
                "sk": {"S": self._user_org_sk(membership.tenant_id)},
                "tenant_id": {"S": membership.tenant_id},
                "user_id": {"S": membership.user_id},
                "role": {"S": membership.role},
            },
        )

    def get_membership(self, tenant_id: str, user_id: str) -> Membership | None:
        response = self.client.get_item(
            TableName=self.table_name,
            Key={
                "pk": {"S": self._org_pk(tenant_id)},
                "sk": {"S": self._member_sk(user_id)},
            },
        )
        item = response.get("Item")
        if item is None:
            return None
        return _membership_from_item(item)

    def list_memberships(self, tenant_id: str) -> list[Membership]:
        response = self.client.query(
            TableName=self.table_name,
            KeyConditionExpression="pk = :pk AND begins_with(sk, :prefix)",
            ExpressionAttributeValues={
                ":pk": {"S": self._org_pk(tenant_id)},
                ":prefix": {"S": "member#"},
            },
        )
        memberships: list[Membership] = []
        for row in response.get("Items", []):
            memberships.append(_membership_from_item(row))
        return sorted(memberships, key=lambda membership: membership.user_id)

    def list_organizations_for_user(self, user_id: str) -> list[Organization]:
        response = self.client.query(
            TableName=self.table_name,
            KeyConditionExpression="pk = :pk AND begins_with(sk, :prefix)",
            ExpressionAttributeValues={
                ":pk": {"S": self._user_pk(user_id)},
                ":prefix": {"S": "org#"},
            },
        )
        organizations: list[Organization] = []
        for row in response.get("Items", []):
            tenant_id = row["tenant_id"]["S"]
            organization = self.get_organization(tenant_id)
            if organization is not None:
                organizations.append(organization)
        return sorted(organizations, key=lambda organization: organization.tenant_id)

    def put_invitation(self, invitation: Invitation) -> None:
        self.client.put_item(
            TableName=self.table_name,
            Item=_invitation_item(invitation),
        )
        self.client.put_item(
            TableName=self.table_name,
            Item={
                "pk": {"S": self._invitation_lookup_pk(invitation.invitation_id)},
                "sk": {"S": "meta"},
                "tenant_id": {"S": invitation.tenant_id},
                "invitation_id": {"S": invitation.invitation_id},
            },
        )

    def get_invitation(self, invitation_id: str) -> Invitation | None:
        response = self.client.get_item(
            TableName=self.table_name,
            Key={
                "pk": {"S": self._invitation_lookup_pk(invitation_id)},
                "sk": {"S": "meta"},
            },
        )
        item = response.get("Item")
        if item is None:
            return None
        tenant_id = item["tenant_id"]["S"]
        canonical = self.client.get_item(
            TableName=self.table_name,
            Key={
                "pk": {"S": self._org_pk(tenant_id)},
                "sk": {"S": self._invite_sk(invitation_id)},
            },
        )
        canonical_item = canonical.get("Item")
        if canonical_item is None:
            return None
        return _invitation_from_item(canonical_item)

    def _channel_pk(self, tenant_id: str, channel_id: str) -> str:
        return f"{tenant_id}#channel#{channel_id}"

    def _channel_lookup_pk(self, channel_id: str) -> str:
        return f"channel_lookup#{channel_id}"

    def _turn_pk(self, tenant_id: str, turn_id: str) -> str:
        return f"{tenant_id}#turn#{turn_id}"

    def _roster_pk(self, tenant_id: str) -> str:
        return f"{tenant_id}#roster"

    def _bot_name_sk(self, user_id: str, name: str) -> str:
        return f"bot_name#{user_id}#{name}"

    def _channel_roster_sk(self, user_id: str, channel_id: str) -> str:
        return f"channel#{user_id}#{channel_id}"

    def _task_pk(self, tenant_id: str, task_id: str) -> str:
        return f"{tenant_id}#task#{task_id}"

    def _task_roster_sk(self, user_id: str, task_id: str) -> str:
        return f"task#{user_id}#{task_id}"

    def _identity_lookup_pk(self, email: str) -> str:
        return f"identity_lookup#{email}"

    def _user_pk(self, user_id: str) -> str:
        return f"user#{user_id}"

    def _org_pk(self, tenant_id: str) -> str:
        return f"{tenant_id}#org"

    def _member_sk(self, user_id: str) -> str:
        return f"member#{user_id}"

    def _user_org_sk(self, tenant_id: str) -> str:
        return f"org#{tenant_id}"

    def _invitation_lookup_pk(self, invitation_id: str) -> str:
        return f"invitation_lookup#{invitation_id}"

    def _invite_sk(self, invitation_id: str) -> str:
        return f"invite#{invitation_id}"

    def _bot_from_item(self, item: dict[str, Any]) -> Bot:
        memory_raw = item.get("memory", {}).get("S", "{}")
        try:
            memory = json.loads(memory_raw)
        except json.JSONDecodeError:
            memory = {}
        if not isinstance(memory, dict):
            memory = {}
        return Bot(
            bot_id=item["bot_id"]["S"],
            tenant_id=item["tenant_id"]["S"],
            user_id=item["user_id"]["S"],
            name=item["name"]["S"],
            memory={str(key): str(value) for key, value in memory.items()},
        )


def _message_item(message: Message, *, pk: str, sk: str) -> dict[str, Any]:
    return {
        "pk": {"S": pk},
        "sk": {"S": sk},
        "tenant_id": {"S": message.tenant_id},
        "channel_id": {"S": message.channel_id},
        "message_id": {"S": message.message_id},
        "seq": {"N": str(message.seq)},
        "author_kind": {"S": message.author_kind},
        "author_id": {"S": message.author_id},
        "body": {"S": message.body},
        "addressed_to_bot_id": {"S": message.addressed_to_bot_id or ""},
        "created_at": {"S": message.created_at.isoformat()},
    }


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
    if turn.prompt_message_seq is not None:
        item["prompt_message_seq"] = {"N": str(turn.prompt_message_seq)}
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
        prompt_message_seq=(
            int(item["prompt_message_seq"]["N"])
            if item.get("prompt_message_seq", {}).get("N") is not None
            else None
        ),
    )


def _task_item(task: Task) -> dict[str, Any]:
    item: dict[str, Any] = {
        "pk": {"S": f"{task.tenant_id}#task#{task.task_id}"},
        "sk": {"S": "meta"},
        "tenant_id": {"S": task.tenant_id},
        "user_id": {"S": task.user_id},
        "task_id": {"S": task.task_id},
        "title": {"S": task.title},
        "status": {"S": task.status},
    }
    if task.evidence is not None:
        item["evidence"] = {"S": task.evidence}
    if task.close_reason is not None:
        item["close_reason"] = {"S": task.close_reason}
    if task.created_by_bot_id is not None:
        item["created_by_bot_id"] = {"S": task.created_by_bot_id}
    if task.updated_by_bot_id is not None:
        item["updated_by_bot_id"] = {"S": task.updated_by_bot_id}
    return item


def _task_from_item(item: dict[str, Any]) -> Task:
    return Task(
        task_id=item["task_id"]["S"],
        tenant_id=item["tenant_id"]["S"],
        user_id=item["user_id"]["S"],
        title=item["title"]["S"],
        status=TaskStatus(item["status"]["S"]),
        evidence=item.get("evidence", {}).get("S") or None,
        close_reason=item.get("close_reason", {}).get("S") or None,
        created_by_bot_id=item.get("created_by_bot_id", {}).get("S") or None,
        updated_by_bot_id=item.get("updated_by_bot_id", {}).get("S") or None,
    )


def _identity_item(identity: Identity) -> dict[str, Any]:
    return {
        "pk": {"S": f"user#{identity.user_id}"},
        "sk": {"S": "identity"},
        "user_id": {"S": identity.user_id},
        "email": {"S": identity.email},
        "created_at": {"S": identity.created_at.isoformat()},
    }


def _identity_from_item(item: dict[str, Any]) -> Identity:
    return Identity(
        user_id=item["user_id"]["S"],
        email=item["email"]["S"],
        created_at=datetime.fromisoformat(item["created_at"]["S"]),
    )


def _organization_item(organization: Organization) -> dict[str, Any]:
    return {
        "pk": {"S": f"{organization.tenant_id}#org"},
        "sk": {"S": "meta"},
        "tenant_id": {"S": organization.tenant_id},
        "name": {"S": organization.name},
        "status": {"S": organization.status},
        "owner_user_id": {"S": organization.owner_user_id},
        "created_at": {"S": organization.created_at.isoformat()},
    }


def _organization_from_item(item: dict[str, Any]) -> Organization:
    return Organization(
        tenant_id=item["tenant_id"]["S"],
        name=item["name"]["S"],
        status=OrganizationStatus(item["status"]["S"]),
        owner_user_id=item["owner_user_id"]["S"],
        created_at=datetime.fromisoformat(item["created_at"]["S"]),
    )


def _membership_item(membership: Membership) -> dict[str, Any]:
    return {
        "pk": {"S": f"{membership.tenant_id}#org"},
        "sk": {"S": f"member#{membership.user_id}"},
        "tenant_id": {"S": membership.tenant_id},
        "user_id": {"S": membership.user_id},
        "role": {"S": membership.role},
        "joined_at": {"S": membership.joined_at.isoformat()},
    }


def _membership_from_item(item: dict[str, Any]) -> Membership:
    return Membership(
        tenant_id=item["tenant_id"]["S"],
        user_id=item["user_id"]["S"],
        role=MemberRole(item["role"]["S"]),
        joined_at=datetime.fromisoformat(item["joined_at"]["S"]),
    )


def _invitation_item(invitation: Invitation) -> dict[str, Any]:
    return {
        "pk": {"S": f"{invitation.tenant_id}#org"},
        "sk": {"S": f"invite#{invitation.invitation_id}"},
        "invitation_id": {"S": invitation.invitation_id},
        "tenant_id": {"S": invitation.tenant_id},
        "email": {"S": invitation.email},
        "invited_by_user_id": {"S": invitation.invited_by_user_id},
        "role": {"S": invitation.role},
        "status": {"S": invitation.status},
        "expires_at": {"N": str(int(invitation.expires_at.timestamp()))},
        "created_at": {"S": invitation.created_at.isoformat()},
    }


def _invitation_from_item(item: dict[str, Any]) -> Invitation:
    expires_epoch = item.get("expires_at", {}).get("N")
    return Invitation(
        invitation_id=item["invitation_id"]["S"],
        tenant_id=item["tenant_id"]["S"],
        email=item["email"]["S"],
        invited_by_user_id=item["invited_by_user_id"]["S"],
        role=MemberRole(item["role"]["S"]),
        status=InvitationStatus(item["status"]["S"]),
        expires_at=(
            datetime.fromtimestamp(int(expires_epoch), tz=UTC)
            if expires_epoch
            else datetime.fromtimestamp(0, tz=UTC)
        ),
        created_at=datetime.fromisoformat(item["created_at"]["S"]),
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
        action_id=item.get("action_id", {}).get("S") or None,
        attempt_id=item.get("attempt_id", {}).get("S") or None,
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
