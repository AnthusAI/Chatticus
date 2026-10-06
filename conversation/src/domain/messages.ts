import type { ChannelListingDependencies } from "../pi/channel-listing.ts";
import { listChannelMessages as listChannelSessionMessages } from "../pi/channel-listing.ts";
import { allocateSeq, put as putMailboxItem, type MailboxItem, type MailboxStore } from "../pi/mailbox.ts";
import type { Clock, IdSource } from "../http/app.ts";
import { ActorNotInChannelError } from "../http/errors.ts";
import type { MessagingStore } from "../store/messaging-store.ts";
import { pythonRepr } from "./bots.ts";
import { type ActorKind, type Channel, type ChannelMessageRecord, requireChannelTenant } from "./channels.ts";
import type { TurnAdmission, TurnRunQueue } from "./turn-admission.ts";

/** One committed channel message. */
export type Message = ChannelMessageRecord;

/** What the message functions read and write. */
export type MessageDependencies = {
	store: MessagingStore;
	ids: IdSource;
	clock: Clock;
	mailbox: MailboxStore;
	turns: TurnAdmission;
	turnRuns: TurnRunQueue;
	listing: ChannelListingDependencies;
	/** How long to wait between looks while a bot's turn is closing; defaults to 50 milliseconds. */
	closingPollMilliseconds?: number;
};

/** One message to admit into a channel. */
export type PostMessageRequest = {
	tenantId: string;
	channelId: string;
	authorKind: ActorKind;
	authorId: string;
	body: string;
	addressedToBotId: string | null;
	idempotencyKey: string | null;
	/** When false the addressed turn is created but no run job is published (the fence probe path). */
	enqueueTurn?: boolean;
};

/** The admitted message and the turn it started or joined, null when it addressed no bot. */
export type PostMessageResult = { message: Message; turnId: string | null };

/** Which messages to list. */
export type ListMessagesRequest = { tenantId: string; channelId: string; afterSeq?: number };

const CLOSING_POLL_ATTEMPTS = 100;
const DEFAULT_CLOSING_POLL_MILLISECONDS = 50;

function requireParticipant(channel: Channel, kind: ActorKind, actorId: string): void {
	for (const participant of channel.participants) {
		if (participant.kind === kind && participant.actorId === actorId) {
			return;
		}
	}
	throw new ActorNotInChannelError(
		`${kind} ${pythonRepr(actorId)} is not a participant of channel ${pythonRepr(channel.channelId)}.`,
	);
}

const sleep = (milliseconds: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, milliseconds));

type Admission = { turnId: string; started: boolean };

async function admitAddressedMessage(
	deps: MessageDependencies,
	channel: Channel,
	message: Message,
	botId: string,
	addressedItem: MailboxItem,
): Promise<Admission> {
	const pollMilliseconds = deps.closingPollMilliseconds ?? DEFAULT_CLOSING_POLL_MILLISECONDS;
	for (let attempt = 0; attempt < CLOSING_POLL_ATTEMPTS; attempt += 1) {
		const open = await deps.turns.openTurn(channel.tenantId, channel.channelId, botId);
		if (open !== null && open.active && !open.closing) {
			if (await deps.turns.steerTurn(open.pointerTurnId, addressedItem)) {
				return { turnId: open.pointerTurnId, started: false };
			}
			continue;
		}
		if (open !== null && open.active && open.closing) {
			await sleep(pollMilliseconds);
			continue;
		}
		await putMailboxItem(deps.mailbox, addressedItem);
		const turnId = deps.ids.next();
		const started = await deps.turns.startTurn({
			tenantId: channel.tenantId,
			channelId: channel.channelId,
			botId,
			turnId,
			promptMessageSeq: message.seq,
			createdAt: message.createdAt,
			startedEventId: deps.ids.next(),
			expectedPointerTurnId: open === null ? null : open.pointerTurnId,
		});
		if (started) {
			return { turnId, started: true };
		}
	}
	throw new Error(
		`Bot ${pythonRepr(botId)} on channel ${pythonRepr(channel.channelId)} did not accept a new turn; its previous turn is still closing.`,
	);
}

/**
 * Admit one message into a channel.
 *
 * Replays an earlier post with the same Idempotency-Key. Otherwise allocates the next sequence with one atomic
 * counter update, writes one mailbox item per participating bot, and for an addressed message either steers the
 * addressed bot's active turn (same turn id, no new turn) or starts that bot's own turn and publishes its run job.
 * A message addressed to a different bot than the one running never steers the running turn.
 *
 * @throws ChannelNotFoundError If the channel is unknown.
 * @throws ChannelTenantMismatchError If the tenant does not own the channel.
 * @throws ActorNotInChannelError If the author or addressee is not a participant.
 */
export async function postMessage(deps: MessageDependencies, request: PostMessageRequest): Promise<PostMessageResult> {
	if (request.idempotencyKey !== null) {
		const cached = await deps.store.getPostIdempotency(request.tenantId, request.idempotencyKey);
		if (cached !== null) {
			return cached;
		}
	}
	const channel = await requireChannelTenant(request.channelId, request.tenantId, deps);
	requireParticipant(channel, request.authorKind, request.authorId);
	if (request.addressedToBotId !== null) {
		requireParticipant(channel, "bot", request.addressedToBotId);
	}
	const seq = await allocateSeq(deps.mailbox, channel.tenantId, channel.channelId);
	const message: Message = {
		messageId: deps.ids.next(),
		channelId: channel.channelId,
		tenantId: channel.tenantId,
		seq,
		authorKind: request.authorKind,
		authorId: request.authorId,
		body: request.body,
		addressedToBotId: request.addressedToBotId,
		createdAt: deps.clock.now(),
	};
	const itemFor = (botId: string): MailboxItem => ({
		tenantId: channel.tenantId,
		botId,
		channelId: channel.channelId,
		seq,
		messageId: message.messageId,
		authorKind: message.authorKind,
		authorId: message.authorId,
		addressedToBotId: message.addressedToBotId,
		body: message.body,
		createdAt: message.createdAt.toISOString(),
	});
	const participatingBotIds = channel.participants
		.filter((participant) => participant.kind === "bot")
		.map((participant) => participant.actorId);
	for (const botId of participatingBotIds) {
		if (botId !== request.addressedToBotId) {
			await putMailboxItem(deps.mailbox, itemFor(botId));
		}
	}
	let turnId: string | null = null;
	if (request.addressedToBotId !== null) {
		const admission = await admitAddressedMessage(
			deps,
			channel,
			message,
			request.addressedToBotId,
			itemFor(request.addressedToBotId),
		);
		turnId = admission.turnId;
		if (admission.started && request.enqueueTurn !== false) {
			await deps.turnRuns.enqueue({
				tenantId: channel.tenantId,
				channelId: channel.channelId,
				botId: request.addressedToBotId,
				turnId: admission.turnId,
				requiredCapabilities: ["cpu"],
			});
		}
	}
	if (request.idempotencyKey !== null) {
		await deps.store.putPostIdempotency(request.tenantId, request.idempotencyKey, message, turnId);
	}
	return { message, turnId };
}

/**
 * List a channel's committed messages in sequence order.
 *
 * Merges every participating bot session's channel log and mailbox, so a message appears once however many sessions
 * hold it and whether or not it has been drained into a session yet.
 *
 * @throws ChannelNotFoundError If the channel is unknown.
 * @throws ChannelTenantMismatchError If the tenant does not own the channel.
 */
export async function listMessages(deps: MessageDependencies, request: ListMessagesRequest): Promise<Message[]> {
	const channel = await requireChannelTenant(request.channelId, request.tenantId, deps);
	const botIds = channel.participants
		.filter((participant) => participant.kind === "bot")
		.map((participant) => participant.actorId);
	const listed = await listChannelSessionMessages(
		deps.listing,
		channel.tenantId,
		channel.channelId,
		botIds,
		request.afterSeq ?? 0,
	);
	return listed.map((entry) => ({
		messageId: entry.message_id,
		channelId: entry.channel_id,
		tenantId: entry.tenant_id,
		seq: entry.seq,
		authorKind: entry.author_kind as ActorKind,
		authorId: entry.author_id,
		body: entry.body,
		addressedToBotId: entry.addressed_to_bot_id,
		createdAt: new Date(entry.created_at),
	}));
}
