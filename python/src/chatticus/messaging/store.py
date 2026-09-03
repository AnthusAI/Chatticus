"""Durable channel, message, turn event, and chunk persistence."""

from __future__ import annotations

import json
import threading
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any, Protocol

from chatticus.budget_rollup.models import (
    BudgetAlertEvent,
    BudgetRollupRow,
    BudgetThresholdState,
)
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
    CostClass,
    DuplicateBotNameError,
    Identity,
    Invitation,
    InvitationStatus,
    MemberRole,
    Membership,
    Message,
    Organization,
    OrganizationCreationRateLimitedError,
    OrganizationOwnerCapError,
    OrganizationStatus,
    PendingComputerToolSnapshot,
    StaleAttemptError,
    Task,
    TaskStatus,
    Turn,
    TurnEvent,
    TurnEventKind,
    TurnStatus,
    WaitlistSignup,
    WorkerRecord,
    WorkerRegistration,
)
from chatticus.vendor_ledger import VendorLedgerRow


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

    def get_bot_by_name(self, tenant_id: str, name: str) -> Bot | None:
        """Load one bot by the organization's chosen name."""

    def list_bots(self, tenant_id: str) -> list[Bot]:
        """Return named bots in one organization."""

    def put_computer(self, computer: Computer) -> None:
        """Persist the household computer record."""

    def get_computer(self, tenant_id: str) -> Computer | None:
        """Load the organization computer."""

    def claim_host_start_dispatch(self, tenant_id: str, generation: int) -> bool:
        """Return True when this caller first claims host start for generation."""

    def release_host_start_dispatch(self, generation: int) -> None:
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

    def list_organizations_by_status(
        self, status: OrganizationStatus
    ) -> list[Organization]:
        """Return every organization with one lifecycle status."""

    def record_organization_creation_attempt(
        self,
        user_id: str,
        *,
        now: datetime,
        limit: int,
        window: timedelta,
    ) -> None:
        """Increment one creation attempt and refuse when over the limit."""

    def create_pending_organization(
        self,
        owner: Identity,
        name: str,
        *,
        tenant_id: str,
        now: datetime,
        enforce_owner_cap: bool,
    ) -> Organization:
        """Create one pending organization, owner membership, and indexes."""

    def put_invitation(self, invitation: Invitation) -> None:
        """Persist one invitation and its lookup items."""

    def get_invitation(self, invitation_id: str) -> Invitation | None:
        """Load one invitation by id."""

    def list_pending_invitations_for_email(self, email: str) -> list[Invitation]:
        """Return pending invitations addressed to one normalized email."""

    def list_messaging_user_ids(self, tenant_id: str) -> tuple[str, ...]:
        """Return distinct user ids referenced by one tenant's messaging rows."""

    def put_worker(self, record: WorkerRecord) -> None:
        """Persist one registered worker and its credential hash."""

    def get_worker(self, tenant_id: str, worker_id: str) -> WorkerRecord | None:
        """Load one worker from the tenant roster."""

    def list_workers(self, tenant_id: str) -> list[WorkerRecord]:
        """Return every worker registered for one tenant."""

    def get_vendor_ledger_row(
        self, tenant_id: str, turn_id: str
    ) -> VendorLedgerRow | None:
        """Load one vendor spend ledger row for a turn."""

    def insert_vendor_ledger_row(self, row: VendorLedgerRow) -> VendorLedgerRow:
        """Insert the first vendor spend row for one turn."""

    def accumulate_vendor_ledger_usage(
        self,
        tenant_id: str,
        turn_id: str,
        *,
        input_delta: int,
        output_delta: int,
        cost_delta: Decimal | None,
    ) -> VendorLedgerRow:
        """Add token and optional cost deltas to an existing ledger row."""

    def list_vendor_ledger_rows_for_tenant(
        self, tenant_id: str
    ) -> list[VendorLedgerRow]:
        """Return every vendor ledger row for one tenant."""

    def get_budget_rollup_row(
        self, tenant_id: str, environment: str, rollup_date: date
    ) -> BudgetRollupRow | None:
        """Load one org-environment-day rollup row."""

    def put_budget_rollup_row(self, row: BudgetRollupRow) -> BudgetRollupRow:
        """Insert or replace one org-environment-day rollup row."""

    def list_budget_rollup_rows_for_day(
        self, tenant_id: str, environment: str, rollup_date: date
    ) -> list[BudgetRollupRow]:
        """Return rollup rows for one tenant, environment, and day."""

    def get_account_budget_rollup_row(
        self, environment: str, rollup_date: date
    ) -> BudgetRollupRow | None:
        """Load the account-level rollup row for one environment and day."""

    def put_account_budget_rollup_row(self, row: BudgetRollupRow) -> BudgetRollupRow:
        """Insert or replace the account-level rollup row."""

    def get_budget_threshold_state(
        self, environment: str
    ) -> BudgetThresholdState | None:
        """Load vendor threshold notification dedup state."""

    def put_budget_threshold_state(self, state: BudgetThresholdState) -> None:
        """Persist vendor threshold notification dedup state."""


    def put_waitlist_signup(self, signup: WaitlistSignup) -> None:
        """Persist one waitlist signup."""

    def get_waitlist_signup(self, email: str) -> WaitlistSignup | None:
        """Load one waitlist signup by email."""


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
        self._org_creation_attempts: dict[str, list[datetime]] = {}
        self._owned_org_caps: dict[str, str] = {}
        self._memberships: dict[tuple[str, str], Membership] = {}
        self._user_org_index: dict[tuple[str, str], Membership] = {}
        self._invitations: dict[str, Invitation] = {}
        self._workers: dict[tuple[str, str], WorkerRecord] = {}
        self._vendor_ledger: dict[tuple[str, str], VendorLedgerRow] = {}
        self._budget_rollups: dict[tuple[str, str, str], BudgetRollupRow] = {}
        self._budget_threshold_state: dict[str, BudgetThresholdState] = {}
        self._waitlist_signups: dict[str, WaitlistSignup] = {}
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
                if channel.tenant_id == tenant_id
                and any(
                    participant.kind == ActorKind.HUMAN
                    and participant.actor_id == user_id
                    for participant in channel.participants
                )
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
            if reserve_name and self.get_bot_by_name(bot.tenant_id, bot.name):
                raise DuplicateBotNameError(
                    f"Bot named {bot.name!r} already exists for tenant "
                    f"{bot.tenant_id!r}."
                )
            self._bots[(bot.tenant_id, bot.bot_id)] = bot

    def get_bot(self, tenant_id: str, bot_id: str) -> Bot | None:
        return self._bots.get((tenant_id, bot_id))

    def get_bot_by_name(self, tenant_id: str, name: str) -> Bot | None:
        for bot in self._bots.values():
            if bot.tenant_id == tenant_id and bot.name == name:
                return bot
        return None

    def list_bots(self, tenant_id: str) -> list[Bot]:
        return sorted(
            (bot for bot in self._bots.values() if bot.tenant_id == tenant_id),
            key=lambda bot: bot.name,
        )

    def put_computer(self, computer: Computer) -> None:
        self._computers[computer.tenant_id] = computer

    def get_computer(self, tenant_id: str) -> Computer | None:
        return self._computers.get(tenant_id)

    def claim_host_start_dispatch(self, tenant_id: str, generation: int) -> bool:
        with self._lock:
            computer = self._computers.get(tenant_id)
            if computer is None:
                return False
            if computer.host_start_dispatched_generation >= generation:
                return False
            computer.host_start_dispatched_generation = generation
            self._computers[tenant_id] = computer
            return True

    def release_host_start_dispatch(self, tenant_id: str, generation: int) -> None:
        with self._lock:
            computer = self._computers.get(tenant_id)
            if computer is None:
                return
            if computer.host_start_dispatched_generation != generation:
                return
            computer.host_start_dispatched_generation = generation - 1
            self._computers[tenant_id] = computer

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

    def list_organizations_by_status(
        self, status: OrganizationStatus
    ) -> list[Organization]:
        return sorted(
            (
                organization
                for organization in self._organizations.values()
                if organization.status == status
            ),
            key=lambda organization: organization.tenant_id,
        )

    def record_organization_creation_attempt(
        self,
        user_id: str,
        *,
        now: datetime,
        limit: int,
        window: timedelta,
    ) -> None:
        cutoff = now - window
        attempts = [
            timestamp
            for timestamp in self._org_creation_attempts.get(user_id, [])
            if timestamp > cutoff
        ]
        attempts.append(now)
        self._org_creation_attempts[user_id] = attempts
        if len(attempts) > limit:
            raise OrganizationCreationRateLimitedError(
                f"User {user_id!r} exceeded the organization creation rate limit "
                f"of {limit} attempts per {window}."
            )

    def create_pending_organization(
        self,
        owner: Identity,
        name: str,
        *,
        tenant_id: str,
        now: datetime,
        enforce_owner_cap: bool,
    ) -> Organization:
        if enforce_owner_cap and owner.user_id in self._owned_org_caps:
            raise OrganizationOwnerCapError(
                f"User {owner.user_id!r} already owns an organization."
            )
        organization = Organization(
            tenant_id=tenant_id,
            name=name,
            status=OrganizationStatus.PENDING,
            owner_user_id=owner.user_id,
            created_at=now,
        )
        membership = Membership(
            tenant_id=tenant_id,
            user_id=owner.user_id,
            role=MemberRole.OWNER,
            joined_at=now,
        )
        self.put_organization(organization)
        self.put_membership(membership)
        if enforce_owner_cap:
            self._owned_org_caps[owner.user_id] = tenant_id
        return organization

    def list_messaging_user_ids(self, tenant_id: str) -> tuple[str, ...]:
        user_ids: set[str] = set()
        for channel in self._channels.values():
            if channel.tenant_id == tenant_id:
                for participant in channel.participants:
                    if participant.kind == ActorKind.HUMAN:
                        user_ids.add(participant.actor_id)
        for task in self._tasks.values():
            if task.tenant_id == tenant_id:
                user_ids.add(task.user_id)
        for indexed_tenant_id in self._computers:
            if indexed_tenant_id == tenant_id:
                # Legacy org computers no longer carry a user id.
                pass
        return tuple(sorted(user_ids))

    def put_worker(self, record: WorkerRecord) -> None:
        tenant_id = record.registration.tenant_id
        worker_id = record.registration.worker_id
        self._workers[(tenant_id, worker_id)] = record

    def get_worker(self, tenant_id: str, worker_id: str) -> WorkerRecord | None:
        return self._workers.get((tenant_id, worker_id))

    def list_workers(self, tenant_id: str) -> list[WorkerRecord]:
        return sorted(
            (
                record
                for (stored_tenant_id, _), record in self._workers.items()
                if stored_tenant_id == tenant_id
            ),
            key=lambda record: record.registration.worker_id,
        )

    def put_invitation(self, invitation: Invitation) -> None:
        self._invitations[invitation.invitation_id] = invitation

    def get_invitation(self, invitation_id: str) -> Invitation | None:
        return self._invitations.get(invitation_id)

    def list_pending_invitations_for_email(self, email: str) -> list[Invitation]:
        return sorted(
            (
                invitation
                for invitation in self._invitations.values()
                if invitation.email == email
                and invitation.status == InvitationStatus.PENDING
            ),
            key=lambda invitation: invitation.created_at,
        )

    def get_vendor_ledger_row(
        self, tenant_id: str, turn_id: str
    ) -> VendorLedgerRow | None:
        return self._vendor_ledger.get((tenant_id, turn_id))

    def insert_vendor_ledger_row(self, row: VendorLedgerRow) -> VendorLedgerRow:
        key = (row.tenant_id, row.turn_id)
        with self._lock:
            if key in self._vendor_ledger:
                msg = f"Vendor ledger row for turn {row.turn_id!r} already exists."
                raise ValueError(msg)
            self._vendor_ledger[key] = row
            return row

    def accumulate_vendor_ledger_usage(
        self,
        tenant_id: str,
        turn_id: str,
        *,
        input_delta: int,
        output_delta: int,
        cost_delta: Decimal | None,
    ) -> VendorLedgerRow:
        key = (tenant_id, turn_id)
        with self._lock:
            existing = self._vendor_ledger.get(key)
            if existing is None:
                msg = f"Vendor ledger row for turn {turn_id!r} is unknown."
                raise ValueError(msg)
            next_cost = existing.cost_usd
            if cost_delta is not None:
                next_cost = (next_cost or Decimal("0")) + cost_delta
            updated = VendorLedgerRow(
                tenant_id=existing.tenant_id,
                turn_id=existing.turn_id,
                vendor=existing.vendor,
                model=existing.model,
                input_tokens=existing.input_tokens + input_delta,
                output_tokens=existing.output_tokens + output_delta,
                billed_via=existing.billed_via,
                input_price_per_million_usd=existing.input_price_per_million_usd,
                output_price_per_million_usd=existing.output_price_per_million_usd,
                cost_usd=next_cost,
                recorded_at=existing.recorded_at,
            )
            self._vendor_ledger[key] = updated
            return updated

    def list_vendor_ledger_rows_for_tenant(
        self, tenant_id: str
    ) -> list[VendorLedgerRow]:
        rows = [
            row
            for (row_tenant_id, _turn_id), row in self._vendor_ledger.items()
            if row_tenant_id == tenant_id
        ]
        return sorted(rows, key=lambda row: row.recorded_at)

    def get_budget_rollup_row(
        self, tenant_id: str, environment: str, rollup_date: date
    ) -> BudgetRollupRow | None:
        return self._budget_rollups.get(
            (tenant_id, environment, rollup_date.isoformat())
        )

    def put_budget_rollup_row(self, row: BudgetRollupRow) -> BudgetRollupRow:
        key = (row.tenant_id, row.environment, row.rollup_date.isoformat())
        with self._lock:
            self._budget_rollups[key] = row
            return row

    def list_budget_rollup_rows_for_day(
        self, tenant_id: str, environment: str, rollup_date: date
    ) -> list[BudgetRollupRow]:
        row = self.get_budget_rollup_row(tenant_id, environment, rollup_date)
        return [row] if row is not None else []

    def get_account_budget_rollup_row(
        self, environment: str, rollup_date: date
    ) -> BudgetRollupRow | None:
        from chatticus.budget_rollup.models import ACCOUNT_TENANT_ID

        return self.get_budget_rollup_row(ACCOUNT_TENANT_ID, environment, rollup_date)

    def put_account_budget_rollup_row(self, row: BudgetRollupRow) -> BudgetRollupRow:
        return self.put_budget_rollup_row(row)

    def get_budget_threshold_state(
        self, environment: str
    ) -> BudgetThresholdState | None:
        return self._budget_threshold_state.get(environment)

    def put_budget_threshold_state(self, state: BudgetThresholdState) -> None:
        with self._lock:
            self._budget_threshold_state[state.environment] = state

    def put_waitlist_signup(self, signup: WaitlistSignup) -> None:
        with self._lock:
            self._waitlist_signups[signup.email] = signup

    def get_waitlist_signup(self, email: str) -> WaitlistSignup | None:
        return self._waitlist_signups.get(email)


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
        for participant in channel.participants:
            if participant.kind != ActorKind.HUMAN:
                continue
            self.client.put_item(
                TableName=self.table_name,
                Item={
                    "pk": {"S": self._roster_pk(channel.tenant_id)},
                    "sk": {
                        "S": self._channel_roster_sk(
                            participant.actor_id, channel.channel_id
                        )
                    },
                    "tenant_id": {"S": channel.tenant_id},
                    "user_id": {"S": participant.actor_id},
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
            "bot_id": {"S": bot.bot_id},
            "name": {"S": bot.name},
            "memory": {"S": json.dumps(bot.memory)},
        }
        if not reserve_name:
            self.client.put_item(TableName=self.table_name, Item=bot_item)
            return
        name_item = {
            "pk": {"S": self._roster_pk(bot.tenant_id)},
            "sk": {"S": self._bot_name_sk(bot.name)},
            "tenant_id": {"S": bot.tenant_id},
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
                    f"Bot named {bot.name!r} already exists for tenant "
                    f"{bot.tenant_id!r}."
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

    def get_bot_by_name(self, tenant_id: str, name: str) -> Bot | None:
        response = self.client.get_item(
            TableName=self.table_name,
            Key={
                "pk": {"S": self._roster_pk(tenant_id)},
                "sk": {"S": self._bot_name_sk(name)},
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
            if row["name"]["S"] == name:
                return self._bot_from_item(row)
        return None

    def list_bots(self, tenant_id: str) -> list[Bot]:
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
            bots.append(self._bot_from_item(row))
        return sorted(bots, key=lambda bot: bot.name)

    def put_computer(self, computer: Computer) -> None:
        self.client.put_item(
            TableName=self.table_name,
            Item={
                "pk": {"S": self._roster_pk(computer.tenant_id)},
                "sk": {"S": "computer"},
                "tenant_id": {"S": computer.tenant_id},
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

    def get_computer(self, tenant_id: str) -> Computer | None:
        response = self.client.get_item(
            TableName=self.table_name,
            Key={
                "pk": {"S": self._roster_pk(tenant_id)},
                "sk": {"S": "computer"},
            },
        )
        item = response.get("Item")
        if item is None:
            return None
        lease_epoch = int(item.get("host_start_lease_expires_at", {}).get("N", "0"))
        return Computer(
            computer_id=item["computer_id"]["S"],
            tenant_id=item["tenant_id"]["S"],
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

    def claim_host_start_dispatch(self, tenant_id: str, generation: int) -> bool:
        try:
            self.client.update_item(
                TableName=self.table_name,
                Key={
                    "pk": {"S": self._roster_pk(tenant_id)},
                    "sk": {"S": "computer"},
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

    def release_host_start_dispatch(self, tenant_id: str, generation: int) -> None:
        try:
            self.client.update_item(
                TableName=self.table_name,
                Key={
                    "pk": {"S": self._roster_pk(tenant_id)},
                    "sk": {"S": "computer"},
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

    def list_organizations_by_status(
        self, status: OrganizationStatus
    ) -> list[Organization]:
        organizations: list[Organization] = []
        scan_kwargs: dict[str, Any] = {
            "TableName": self.table_name,
            "FilterExpression": (
                "sk = :meta AND attribute_exists(owner_user_id) AND "
                "#status = :status"
            ),
            "ExpressionAttributeNames": {"#status": "status"},
            "ExpressionAttributeValues": {
                ":meta": {"S": "meta"},
                ":status": {"S": status.value},
            },
        }
        while True:
            response = self.client.scan(**scan_kwargs)
            for item in response.get("Items", []):
                organizations.append(_organization_from_item(item))
            last_key = response.get("LastEvaluatedKey")
            if last_key is None:
                break
            scan_kwargs["ExclusiveStartKey"] = last_key
        return sorted(organizations, key=lambda organization: organization.tenant_id)

    def record_organization_creation_attempt(
        self,
        user_id: str,
        *,
        now: datetime,
        limit: int,
        window: timedelta,
    ) -> None:
        window_seconds = max(int(window.total_seconds()), 1)
        bucket = int(now.timestamp()) // window_seconds
        expires_at = int((now + window + timedelta(hours=1)).timestamp())
        response = self.client.update_item(
            TableName=self.table_name,
            Key={
                "pk": {"S": self._user_pk(user_id)},
                "sk": {"S": self._org_create_rate_sk(bucket)},
            },
            UpdateExpression=(
                "SET attempt_count = if_not_exists(attempt_count, :zero) + :one, "
                "expires_at = :expires"
            ),
            ExpressionAttributeValues={
                ":zero": {"N": "0"},
                ":one": {"N": "1"},
                ":expires": {"N": str(expires_at)},
            },
            ReturnValues="ALL_NEW",
        )
        count = int(response["Attributes"]["attempt_count"]["N"])
        if count > limit:
            raise OrganizationCreationRateLimitedError(
                f"User {user_id!r} exceeded the organization creation rate limit "
                f"of {limit} attempts per {window}."
            )

    def create_pending_organization(
        self,
        owner: Identity,
        name: str,
        *,
        tenant_id: str,
        now: datetime,
        enforce_owner_cap: bool,
    ) -> Organization:
        organization = Organization(
            tenant_id=tenant_id,
            name=name,
            status=OrganizationStatus.PENDING,
            owner_user_id=owner.user_id,
            created_at=now,
        )
        membership = Membership(
            tenant_id=tenant_id,
            user_id=owner.user_id,
            role=MemberRole.OWNER,
            joined_at=now,
        )
        transact_items: list[dict[str, Any]] = [
            {
                "Put": {
                    "TableName": self.table_name,
                    "Item": _organization_item(organization),
                }
            },
            {
                "Put": {
                    "TableName": self.table_name,
                    "Item": _membership_item(membership),
                }
            },
            {
                "Put": {
                    "TableName": self.table_name,
                    "Item": {
                        "pk": {"S": self._user_pk(owner.user_id)},
                        "sk": {"S": self._user_org_sk(tenant_id)},
                        "tenant_id": {"S": tenant_id},
                        "user_id": {"S": owner.user_id},
                        "role": {"S": membership.role},
                    },
                }
            },
        ]
        if enforce_owner_cap:
            transact_items.insert(
                0,
                {
                    "Put": {
                        "TableName": self.table_name,
                        "Item": {
                            "pk": {"S": self._user_pk(owner.user_id)},
                            "sk": {"S": self._owned_org_cap_sk()},
                            "user_id": {"S": owner.user_id},
                            "tenant_id": {"S": tenant_id},
                        },
                        "ConditionExpression": "attribute_not_exists(pk)",
                    }
                },
            )
        try:
            self.client.transact_write_items(TransactItems=transact_items)
        except self.client.exceptions.TransactionCanceledException as error:
            if enforce_owner_cap and _transaction_has_conditional_failure(error):
                raise OrganizationOwnerCapError(
                    f"User {owner.user_id!r} already owns an organization."
                ) from error
            raise
        return organization

    def list_messaging_user_ids(self, tenant_id: str) -> tuple[str, ...]:
        user_ids: set[str] = set()
        query_kwargs: dict[str, Any] = {
            "TableName": self.table_name,
            "KeyConditionExpression": "pk = :pk",
            "ExpressionAttributeValues": {
                ":pk": {"S": self._roster_pk(tenant_id)},
            },
        }
        while True:
            response = self.client.query(**query_kwargs)
            for item in response.get("Items", []):
                raw_user_id = item.get("user_id", {}).get("S")
                if raw_user_id:
                    user_ids.add(raw_user_id)
            last_key = response.get("LastEvaluatedKey")
            if last_key is None:
                break
            query_kwargs["ExclusiveStartKey"] = last_key
        return tuple(sorted(user_ids))

    def put_worker(self, record: WorkerRecord) -> None:
        self.client.put_item(
            TableName=self.table_name,
            Item=_worker_item(record),
        )

    def get_worker(self, tenant_id: str, worker_id: str) -> WorkerRecord | None:
        response = self.client.get_item(
            TableName=self.table_name,
            Key={
                "pk": {"S": self._roster_pk(tenant_id)},
                "sk": {"S": f"worker#{worker_id}"},
            },
        )
        item = response.get("Item")
        if item is None:
            return None
        return _worker_from_item(item)

    def list_workers(self, tenant_id: str) -> list[WorkerRecord]:
        response = self.client.query(
            TableName=self.table_name,
            KeyConditionExpression="pk = :pk AND begins_with(sk, :prefix)",
            ExpressionAttributeValues={
                ":pk": {"S": self._roster_pk(tenant_id)},
                ":prefix": {"S": "worker#"},
            },
        )
        workers = [_worker_from_item(item) for item in response.get("Items", [])]
        return sorted(workers, key=lambda record: record.registration.worker_id)

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
        self.client.put_item(
            TableName=self.table_name,
            Item={
                "pk": {"S": self._invitation_email_pk(invitation.email)},
                "sk": {"S": self._invitation_email_sk(invitation.invitation_id)},
                "invitation_id": {"S": invitation.invitation_id},
                "tenant_id": {"S": invitation.tenant_id},
                "expires_at": {"N": str(int(invitation.expires_at.timestamp()))},
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

    def list_pending_invitations_for_email(self, email: str) -> list[Invitation]:
        response = self.client.query(
            TableName=self.table_name,
            KeyConditionExpression="pk = :pk AND begins_with(sk, :prefix)",
            ExpressionAttributeValues={
                ":pk": {"S": self._invitation_email_pk(email)},
                ":prefix": {"S": "pending#"},
            },
        )
        invitations: list[Invitation] = []
        for item in response.get("Items", []):
            invitation_id = item["invitation_id"]["S"]
            invitation = self.get_invitation(invitation_id)
            if invitation is None:
                continue
            if invitation.status != InvitationStatus.PENDING:
                continue
            invitations.append(invitation)
        return sorted(invitations, key=lambda invitation: invitation.created_at)

    def get_vendor_ledger_row(
        self, tenant_id: str, turn_id: str
    ) -> VendorLedgerRow | None:
        response = self.client.get_item(
            TableName=self.table_name,
            Key={
                "pk": {"S": self._vendor_ledger_pk(tenant_id)},
                "sk": {"S": self._vendor_ledger_sk(turn_id)},
            },
        )
        item = response.get("Item")
        if item is None:
            return None
        return _vendor_ledger_from_item(item)

    def insert_vendor_ledger_row(self, row: VendorLedgerRow) -> VendorLedgerRow:
        try:
            self.client.put_item(
                TableName=self.table_name,
                Item=_vendor_ledger_item(row),
                ConditionExpression="attribute_not_exists(sk)",
            )
        except Exception as error:
            if getattr(error, "response", {}).get("Error", {}).get("Code") == (
                "ConditionalCheckFailedException"
            ):
                msg = f"Vendor ledger row for turn {row.turn_id!r} already exists."
                raise ValueError(msg) from error
            raise
        stored = self.get_vendor_ledger_row(row.tenant_id, row.turn_id)
        if stored is None:
            msg = f"Vendor ledger row for turn {row.turn_id!r} was not persisted."
            raise RuntimeError(msg)
        return stored

    def accumulate_vendor_ledger_usage(
        self,
        tenant_id: str,
        turn_id: str,
        *,
        input_delta: int,
        output_delta: int,
        cost_delta: Decimal | None,
    ) -> VendorLedgerRow:
        update_expression = "ADD input_tokens :input_delta, output_tokens :output_delta"
        values: dict[str, Any] = {
            ":input_delta": {"N": str(input_delta)},
            ":output_delta": {"N": str(output_delta)},
        }
        if cost_delta is not None:
            update_expression += ", cost_usd :cost_delta"
            values[":cost_delta"] = {"N": str(cost_delta)}
        self.client.update_item(
            TableName=self.table_name,
            Key={
                "pk": {"S": self._vendor_ledger_pk(tenant_id)},
                "sk": {"S": self._vendor_ledger_sk(turn_id)},
            },
            UpdateExpression=update_expression,
            ConditionExpression="attribute_exists(pk)",
            ExpressionAttributeValues=values,
        )
        stored = self.get_vendor_ledger_row(tenant_id, turn_id)
        if stored is None:
            msg = f"Vendor ledger row for turn {turn_id!r} is unknown after update."
            raise RuntimeError(msg)
        return stored

    def list_vendor_ledger_rows_for_tenant(
        self, tenant_id: str
    ) -> list[VendorLedgerRow]:
        response = self.client.query(
            TableName=self.table_name,
            KeyConditionExpression="pk = :pk",
            ExpressionAttributeValues={
                ":pk": {"S": self._vendor_ledger_pk(tenant_id)},
            },
        )
        rows = [_vendor_ledger_from_item(item) for item in response.get("Items", [])]
        return sorted(rows, key=lambda row: row.recorded_at)

    def get_budget_rollup_row(
        self, tenant_id: str, environment: str, rollup_date: date
    ) -> BudgetRollupRow | None:
        response = self.client.get_item(
            TableName=self.table_name,
            Key={
                "pk": {"S": self._budget_rollup_pk(tenant_id)},
                "sk": {"S": self._budget_rollup_sk(environment, rollup_date)},
            },
        )
        item = response.get("Item")
        if item is None:
            return None
        return _budget_rollup_from_item(item)

    def put_budget_rollup_row(self, row: BudgetRollupRow) -> BudgetRollupRow:
        self.client.put_item(
            TableName=self.table_name,
            Item=_budget_rollup_item(row),
        )
        stored = self.get_budget_rollup_row(
            row.tenant_id, row.environment, row.rollup_date
        )
        if stored is None:
            msg = (
                f"Budget rollup row for {row.tenant_id!r} "
                f"{row.environment!r} on {row.rollup_date!r} was not persisted."
            )
            raise RuntimeError(msg)
        return stored

    def list_budget_rollup_rows_for_day(
        self, tenant_id: str, environment: str, rollup_date: date
    ) -> list[BudgetRollupRow]:
        row = self.get_budget_rollup_row(tenant_id, environment, rollup_date)
        return [row] if row is not None else []

    def get_account_budget_rollup_row(
        self, environment: str, rollup_date: date
    ) -> BudgetRollupRow | None:
        from chatticus.budget_rollup.models import ACCOUNT_TENANT_ID

        return self.get_budget_rollup_row(ACCOUNT_TENANT_ID, environment, rollup_date)

    def put_account_budget_rollup_row(self, row: BudgetRollupRow) -> BudgetRollupRow:
        return self.put_budget_rollup_row(row)

    def get_budget_threshold_state(
        self, environment: str
    ) -> BudgetThresholdState | None:
        from chatticus.budget_rollup.models import ACCOUNT_TENANT_ID

        response = self.client.get_item(
            TableName=self.table_name,
            Key={
                "pk": {"S": self._budget_rollup_pk(ACCOUNT_TENANT_ID)},
                "sk": {"S": self._budget_threshold_state_sk(environment)},
            },
        )
        item = response.get("Item")
        if item is None:
            return None
        return BudgetThresholdState(
            environment=environment,
            last_notified_band=int(item["last_notified_band"]["N"]),
            updated_at=datetime.fromisoformat(item["updated_at"]["S"]),
        )

    def put_budget_threshold_state(self, state: BudgetThresholdState) -> None:
        from chatticus.budget_rollup.models import ACCOUNT_TENANT_ID

        self.client.put_item(
            TableName=self.table_name,
            Item={
                "pk": {"S": self._budget_rollup_pk(ACCOUNT_TENANT_ID)},
                "sk": {"S": self._budget_threshold_state_sk(state.environment)},
                "last_notified_band": {"N": str(state.last_notified_band)},
                "updated_at": {"S": state.updated_at.isoformat()},
            },
        )

    def put_waitlist_signup(self, signup: WaitlistSignup) -> None:
        self.client.put_item(
            TableName=self.table_name,
            Item={
                "pk": {"S": f"WAITLIST#{signup.email}"},
                "sk": {"S": "SIGNUP"},
                "email": {"S": signup.email},
                "fit_answers": {"S": json.dumps(signup.fit_answers)},
                "aws_readiness_answers": {"S": json.dumps(signup.aws_readiness_answers)},
                "price_answers": {"S": json.dumps(signup.price_answers)},
                "complete": {"BOOL": signup.complete},
                "created_at": {"S": signup.created_at.isoformat()},
            },
        )

    def get_waitlist_signup(self, email: str) -> WaitlistSignup | None:
        response = self.client.get_item(
            TableName=self.table_name,
            Key={
                "pk": {"S": f"WAITLIST#{email}"},
                "sk": {"S": "SIGNUP"},
            },
        )
        item = response.get("Item")
        if item is None:
            return None
        return WaitlistSignup(
            email=item["email"]["S"],
            fit_answers=json.loads(item["fit_answers"]["S"]),
            aws_readiness_answers=json.loads(item["aws_readiness_answers"]["S"]),
            price_answers=json.loads(item["price_answers"]["S"]),
            complete=item.get("complete", {}).get("BOOL", False),
            created_at=datetime.fromisoformat(item["created_at"]["S"]),
        )

    def _channel_pk(self, tenant_id: str, channel_id: str) -> str:
        return f"{tenant_id}#channel#{channel_id}"

    def _channel_lookup_pk(self, channel_id: str) -> str:
        return f"channel_lookup#{channel_id}"

    def _turn_pk(self, tenant_id: str, turn_id: str) -> str:
        return f"{tenant_id}#turn#{turn_id}"

    def _roster_pk(self, tenant_id: str) -> str:
        return f"{tenant_id}#roster"

    def _bot_name_sk(self, name: str) -> str:
        return f"bot_name#{name}"

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

    def _owned_org_cap_sk(self) -> str:
        return "owned_org#cap"

    def _org_create_rate_sk(self, bucket: int) -> str:
        return f"org_create_rate#{bucket}"

    def _invitation_lookup_pk(self, invitation_id: str) -> str:
        return f"invitation_lookup#{invitation_id}"

    def _invitation_email_pk(self, email: str) -> str:
        return f"invitation_email#{email}"

    def _invitation_email_sk(self, invitation_id: str) -> str:
        return f"pending#{invitation_id}"

    def _invite_sk(self, invitation_id: str) -> str:
        return f"invite#{invitation_id}"

    def _vendor_ledger_pk(self, tenant_id: str) -> str:
        return f"{tenant_id}#vendor_ledger"

    def _vendor_ledger_sk(self, turn_id: str) -> str:
        return f"turn#{turn_id}"

    def _budget_rollup_pk(self, tenant_id: str) -> str:
        return f"{tenant_id}#budget_rollup"

    def _budget_rollup_sk(self, environment: str, rollup_date: date) -> str:
        return f"{environment}#day#{rollup_date.isoformat()}"

    def _budget_threshold_state_sk(self, environment: str) -> str:
        return f"{environment}#threshold_state"

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


def _transaction_has_conditional_failure(error: Any) -> bool:
    reasons = error.response.get("CancellationReasons", ())
    return any(
        isinstance(reason, dict) and reason.get("Code") == "ConditionalCheckFailed"
        for reason in reasons
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


def _worker_item(record: WorkerRecord) -> dict[str, Any]:
    registration = record.registration
    item: dict[str, Any] = {
        "pk": {"S": f"{registration.tenant_id}#roster"},
        "sk": {"S": f"worker#{registration.worker_id}"},
        "worker_id": {"S": registration.worker_id},
        "tenant_id": {"S": registration.tenant_id},
        "cost_class": {"S": registration.cost_class.value},
        "capabilities": {"S": json.dumps(sorted(registration.capabilities))},
        "token_hash": {"S": record.token_hash},
        "last_heartbeat_at": {"S": record.last_heartbeat_at.isoformat()},
    }
    if registration.computer_id is not None:
        item["computer_id"] = {"S": registration.computer_id}
    if record.hydrated_snapshot_generation is not None:
        item["hydrated_snapshot_generation"] = {
            "N": str(record.hydrated_snapshot_generation)
        }
    return item


def _worker_from_item(item: dict[str, Any]) -> WorkerRecord:
    capabilities_raw = item.get("capabilities", {}).get("S", "[]")
    try:
        capabilities_list = json.loads(capabilities_raw)
    except json.JSONDecodeError:
        capabilities_list = []
    if not isinstance(capabilities_list, list):
        capabilities_list = []
    hydrated = item.get("hydrated_snapshot_generation", {}).get("N")
    return WorkerRecord(
        registration=WorkerRegistration(
            worker_id=item["worker_id"]["S"],
            tenant_id=item["tenant_id"]["S"],
            cost_class=CostClass(item["cost_class"]["S"]),
            capabilities=frozenset(str(cap) for cap in capabilities_list),
            computer_id=item.get("computer_id", {}).get("S") or None,
        ),
        last_heartbeat_at=datetime.fromisoformat(item["last_heartbeat_at"]["S"]),
        token_hash=item["token_hash"]["S"],
        hydrated_snapshot_generation=int(hydrated) if hydrated is not None else None,
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


def _vendor_ledger_item(row: VendorLedgerRow) -> dict[str, Any]:
    item: dict[str, Any] = {
        "pk": {"S": f"{row.tenant_id}#vendor_ledger"},
        "sk": {"S": f"turn#{row.turn_id}"},
        "tenant_id": {"S": row.tenant_id},
        "turn_id": {"S": row.turn_id},
        "vendor": {"S": row.vendor},
        "model": {"S": row.model},
        "input_tokens": {"N": str(row.input_tokens)},
        "output_tokens": {"N": str(row.output_tokens)},
        "billed_via": {"S": row.billed_via},
        "recorded_at": {"S": row.recorded_at.isoformat()},
    }
    if row.input_price_per_million_usd is not None:
        item["input_price_per_million_usd"] = {
            "N": str(row.input_price_per_million_usd)
        }
    if row.output_price_per_million_usd is not None:
        item["output_price_per_million_usd"] = {
            "N": str(row.output_price_per_million_usd)
        }
    if row.cost_usd is not None:
        item["cost_usd"] = {"N": str(row.cost_usd)}
    return item


def _optional_decimal(item: dict[str, Any], key: str) -> Decimal | None:
    raw = item.get(key, {}).get("N")
    if raw is None:
        return None
    return Decimal(raw)


def _vendor_ledger_from_item(item: dict[str, Any]) -> VendorLedgerRow:
    return VendorLedgerRow(
        tenant_id=item["tenant_id"]["S"],
        turn_id=item["turn_id"]["S"],
        vendor=item["vendor"]["S"],
        model=item["model"]["S"],
        input_tokens=int(item["input_tokens"]["N"]),
        output_tokens=int(item["output_tokens"]["N"]),
        billed_via=item["billed_via"]["S"],
        input_price_per_million_usd=_optional_decimal(
            item, "input_price_per_million_usd"
        ),
        output_price_per_million_usd=_optional_decimal(
            item, "output_price_per_million_usd"
        ),
        cost_usd=_optional_decimal(item, "cost_usd"),
        recorded_at=datetime.fromisoformat(item["recorded_at"]["S"]),
    )


def _budget_rollup_item(row: BudgetRollupRow) -> dict[str, Any]:
    item: dict[str, Any] = {
        "pk": {"S": f"{row.tenant_id}#budget_rollup"},
        "sk": {"S": f"{row.environment}#day#{row.rollup_date.isoformat()}"},
        "tenant_id": {"S": row.tenant_id},
        "environment": {"S": row.environment},
        "rollup_date": {"S": row.rollup_date.isoformat()},
        "vendor_cost_usd": {"N": str(row.vendor_cost_usd)},
        "ce_status": {"S": row.ce_status},
        "updated_at": {"S": row.updated_at.isoformat()},
        "alert_events": {
            "S": json.dumps(_budget_alert_events_to_json(row.alert_events))
        },
    }
    if row.aws_cost_usd is not None:
        item["aws_cost_usd"] = {"N": str(row.aws_cost_usd)}
    if row.combined_report_usd is not None:
        item["combined_report_usd"] = {"N": str(row.combined_report_usd)}
    return item


def _budget_rollup_from_item(item: dict[str, Any]) -> BudgetRollupRow:
    alert_events_raw = item.get("alert_events", {}).get("S", "[]")
    alert_payloads = json.loads(alert_events_raw)
    alert_events = tuple(
        BudgetAlertEvent(
            source=str(entry["source"]),
            fired_at=datetime.fromisoformat(str(entry["fired_at"])),
            detail=str(entry["detail"]),
        )
        for entry in alert_payloads
    )
    return BudgetRollupRow(
        tenant_id=item["tenant_id"]["S"],
        environment=item["environment"]["S"],
        rollup_date=date.fromisoformat(item["rollup_date"]["S"]),
        aws_cost_usd=_optional_decimal(item, "aws_cost_usd"),
        vendor_cost_usd=Decimal(item["vendor_cost_usd"]["N"]),
        combined_report_usd=_optional_decimal(item, "combined_report_usd"),
        ce_status=item["ce_status"]["S"],
        alert_events=alert_events,
        updated_at=datetime.fromisoformat(item["updated_at"]["S"]),
    )


def _budget_alert_events_to_json(
    events: tuple[BudgetAlertEvent, ...],
) -> list[dict[str, str]]:
    return [
        {
            "source": event.source,
            "fired_at": event.fired_at.isoformat(),
            "detail": event.detail,
        }
        for event in events
    ]


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
