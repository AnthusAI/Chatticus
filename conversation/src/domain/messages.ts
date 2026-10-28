import { createHash, randomUUID } from "node:crypto";
import type { ChannelListingDependencies } from "../pi/channel-listing.ts";
import type { ToolActivityItem } from "../pi/message-activity.ts";
import { listChannelMessages as listChannelSessionMessages } from "../pi/channel-listing.ts";
import { allocateSeq, put as putMailboxItem, type MailboxItem, type MailboxStore } from "../pi/mailbox.ts";
import type { Clock, IdSource } from "../http/app.ts";
import { ActorNotInChannelError, IdempotencyKeyReuseError, IdempotencyReservationBusyError } from "../http/errors.ts";
import { householdConversationGrant } from "../policy/capability-policy.ts";
import type { MessagingStore, PostIdempotencyReservation } from "../store/messaging-store.ts";
import { pythonRepr } from "./bots.ts";
import { type ActorKind, type Channel, type ChannelMessageRecord, type MessageOrigin, requireChannelTenant } from "./channels.ts";
import type { FaultPlan } from "../turn/fault-plan.ts";
import { logicalEnqueueId, requestLogicalEnqueue } from "../turn/probes.ts";
import type { TurnAdmission, TurnProbeQueue, TurnRunQueue } from "./turn-admission.ts";
import type { AdmissionReservationFence } from "./turn-admission.ts";
import { TURN_DEADLINE_SECONDS } from "./turns.ts";

/** One committed channel message. */
export type Message = ChannelMessageRecord & { activity?: ToolActivityItem[] };

/** What the message functions read and write. */
export type MessageDependencies = {
	store: MessagingStore;
	ids: IdSource;
	clock: Clock;
	mailbox: MailboxStore;
	turns: TurnAdmission;
	turnRuns: TurnRunQueue;
	turnProbes: TurnProbeQueue;
	/** Crash injection for tests; never set in production. */
	faults?: FaultPlan;
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
	/** Where the message came from when it arrived over an external transport; absent means the web app. */
	origin?: MessageOrigin;
	/** When false the addressed turn is created but no run job is published (the fence probe path). */
	enqueueTurn?: boolean;
};

/** The admitted message and the turn it started or joined, null when it addressed no bot. */
export type PostMessageResult = { message: Message; turnId: string | null };

/** Which messages to list. */
export type ListMessagesRequest = { tenantId: string; channelId: string; afterSeq?: number };

/** The stored key of an idempotent post: the caller key scoped to its tenant, channel and author. */
export function scopedPostIdempotencyKey(
	request: Pick<PostMessageRequest, "tenantId" | "channelId" | "authorKind" | "authorId" | "idempotencyKey">,
): string | null {
	if (request.idempotencyKey === null) return null;
	return createHash("sha256")
		.update(JSON.stringify([request.tenantId, request.channelId, request.authorKind, request.authorId, request.idempotencyKey]))
		.digest("hex");
}

function postRequestFingerprint(request: PostMessageRequest): string {
	return createHash("sha256")
		.update(JSON.stringify([
			request.tenantId, request.channelId, request.authorKind, request.authorId,
			request.body, request.addressedToBotId, request.enqueueTurn !== false,
		]))
		.digest("hex");
}

const CLOSING_POLL_ATTEMPTS = 100;
const DEFAULT_CLOSING_POLL_MILLISECONDS = 50;

/**
 * Require that an actor takes part in a channel.
 *
 * @throws ActorNotInChannelError If the actor is not a participant.
 */
export function requireParticipant(channel: Channel, kind: ActorKind, actorId: string): void {
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

type Admission = { turnId: string; started: boolean; kind: "started" | "steered" };

async function admitAddressedMessage(
	deps: MessageDependencies,
	channel: Channel,
	message: Message,
	botId: string,
	addressedItem: MailboxItem,
	options: {
		reservedTurnId?: string | null;
		startedEventId?: string | null;
		fence?: AdmissionReservationFence;
	},
): Promise<Admission> {
	const pollMilliseconds = deps.closingPollMilliseconds ?? DEFAULT_CLOSING_POLL_MILLISECONDS;
	for (let attempt = 0; attempt < CLOSING_POLL_ATTEMPTS; attempt += 1) {
		const open = await deps.turns.openTurn(channel.tenantId, channel.channelId, botId);
		if (open !== null && open.active && !open.closing) {
			if (await deps.turns.steerTurn(open.pointerTurnId, addressedItem, options.fence)) {
				return { turnId: open.pointerTurnId, started: false, kind: "steered" };
			}
			continue;
		}
		if (open !== null && open.active && open.closing) {
			await sleep(pollMilliseconds);
			continue;
		}
		const turnId = options.reservedTurnId ?? deps.ids.next();
		// Install the durable recovery wake-up before committing a turn that needs it.
		await deps.turnProbes.send(
			{ tenantId: channel.tenantId, turnId, kind: "deadline", expectAttempt: 0 },
			TURN_DEADLINE_SECONDS,
		);
		const started = await deps.turns.startTurn({
			tenantId: channel.tenantId,
			channelId: channel.channelId,
			botId,
			turnId,
			promptMessageSeq: message.seq,
			promptAuthorId: message.authorId,
			grant: message.authorKind === "human" ? householdConversationGrant() : null,
			createdAt: message.createdAt,
			startedEventId: options.startedEventId ?? deps.ids.next(),
			expectedPointerTurnId: open === null ? null : open.pointerTurnId,
			initialItem: addressedItem,
			...(options.fence === undefined ? {} : { reservationFence: { ...options.fence, now: deps.clock.now() } }),
		});
		if (started) {
			deps.faults?.maybeCrash("message_commit", "after");
			return { turnId, started: true, kind: "started" };
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
	const idempotencyKey = scopedPostIdempotencyKey(request);
	const channel = await requireChannelTenant(request.channelId, request.tenantId, deps);
	requireParticipant(channel, request.authorKind, request.authorId);
	if (request.addressedToBotId !== null) {
		requireParticipant(channel, "bot", request.addressedToBotId);
	}
	deps.faults?.maybeCrash("message_commit", "before");
	let reservation: PostIdempotencyReservation | null = null;
	if (idempotencyKey !== null) {
		const candidate = {
			ownerId: randomUUID(),
			messageId: deps.ids.next(),
			createdAt: deps.clock.now(),
			leaseExpiresAt: new Date(deps.clock.now().getTime() + 30_000),
			reservedTurnId: request.addressedToBotId === null ? null : deps.ids.next(),
			startedEventId: request.addressedToBotId === null ? null : deps.ids.next(),
		};
		for (let attempt = 0; attempt < 100; attempt += 1) {
			const result = await deps.store.reservePostIdempotency(
				request.tenantId,
				idempotencyKey,
				postRequestFingerprint(request),
				candidate,
				deps.clock.now(),
			);
			if (result.state === "conflict") {
				throw new IdempotencyKeyReuseError("The idempotency key was already used with a different message payload.");
			}
			if (result.state === "completed") return result.result;
			if (result.state === "owner") {
				reservation = result.reservation;
				break;
			}
			await sleep(10);
		}
		if (reservation === null) {
			throw new IdempotencyReservationBusyError("The message request is already being processed; retry with the same key.");
		}
	}
	const allocatedSeq = reservation?.seq ?? await allocateSeq(deps.mailbox, channel.tenantId, channel.channelId);
	let seq = allocatedSeq;
	if (reservation !== null) {
		const savedSeq = await deps.store.setPostIdempotencySequence(
			request.tenantId,
			idempotencyKey!,
			reservation.ownerId,
			allocatedSeq,
			deps.clock.now(),
		);
		if (savedSeq === null) {
			throw new IdempotencyReservationBusyError("The message reservation was reclaimed before its sequence was saved.");
		}
		seq = savedSeq;
	}
	const message: Message = {
		messageId: reservation?.messageId ?? deps.ids.next(),
		channelId: channel.channelId,
		tenantId: channel.tenantId,
		seq,
		authorKind: request.authorKind,
		authorId: request.authorId,
		body: request.body,
		addressedToBotId: request.addressedToBotId,
		createdAt: reservation?.createdAt ?? deps.clock.now(),
		...(request.origin === undefined ? {} : { origin: request.origin }),
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
		...(message.origin === undefined ? {} : { origin: message.origin }),
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
		let admission: Admission | null = reservation?.admission === null || reservation?.admission === undefined
			? null
			: { ...reservation.admission, started: reservation.admission.kind === "started" };
		if (admission === null) {
			admission = await admitAddressedMessage(
				deps,
				channel,
				message,
				request.addressedToBotId,
				itemFor(request.addressedToBotId),
				{
					reservedTurnId: reservation?.reservedTurnId,
					startedEventId: reservation?.startedEventId,
					...(reservation === null || idempotencyKey === null ? {} : {
						fence: { tenantId: request.tenantId, idempotencyKey, ownerId: reservation.ownerId, now: deps.clock.now() },
					}),
				},
			);
		}
		turnId = admission.turnId;
		if (reservation?.admission?.kind === "started") {
			// A recovered admitted turn may have crashed before its deadline probe was published.
			// Duplicate probes are harmless: the turn/attempt fence makes stale probes no-ops.
			await deps.turnProbes.send(
				{ tenantId: channel.tenantId, turnId: admission.turnId, kind: "deadline", expectAttempt: 0 },
				TURN_DEADLINE_SECONDS,
			);
		}
		if (admission.kind === "started" && request.enqueueTurn !== false) {
			const fence = reservation === null || idempotencyKey === null ? undefined : {
				tenantId: request.tenantId, idempotencyKey, ownerId: reservation.ownerId, now: deps.clock.now(),
			};
			await requestLogicalEnqueue(
				{ recorder: deps.turns, turnRuns: deps.turnRuns, faults: deps.faults },
				{
					tenantId: channel.tenantId,
					channelId: channel.channelId,
					botId: request.addressedToBotId,
					turnId: admission.turnId,
					requiredCapabilities: ["cpu"],
				},
				logicalEnqueueId(admission.turnId),
				fence,
			);
		}
	}
	if (idempotencyKey !== null) {
		const completed = await deps.store.completePostIdempotency(
			request.tenantId, idempotencyKey, reservation!.ownerId, message, turnId, deps.clock.now(),
		);
		if (!completed) throw new IdempotencyReservationBusyError("The message reservation expired before completion; retry with the same key.");
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
		...(entry.origin === undefined ? {} : { origin: entry.origin }),
		...(entry.activity === undefined ? {} : { activity: entry.activity }),
	}));
}
