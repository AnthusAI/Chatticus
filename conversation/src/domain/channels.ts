import { createHash } from "node:crypto";
import type { IdSource } from "../http/app.ts";
import {
	ActorNotInChannelError,
	ChannelNotFoundError,
	ChannelTenantMismatchError,
	InvalidChannelIdentityError,
} from "../http/errors.ts";
import type { MessagingStore } from "../store/messaging-store.ts";
import { botById, pythonRepr } from "./bots.ts";

export { ActorNotInChannelError, ChannelNotFoundError, ChannelTenantMismatchError, InvalidChannelIdentityError };

/** Who can author a channel message. */
export type ActorKind = "human" | "bot";

/** Canonical identity of a conversation. */
export type ChannelKind = "direct" | "named";

/** A human or bot that can read and post in a channel. */
export interface ChannelParticipant {
	kind: ActorKind;
	actorId: string;
}

/** A conversation. The channel meta item carries nextSeq, the per-channel message sequence. */
export interface Channel {
	channelId: string;
	tenantId: string;
	kind: ChannelKind;
	name: string | null;
	participants: ChannelParticipant[];
	nextSeq: number;
}

/** One committed message row of a channel. */
export interface ChannelMessageRecord {
	messageId: string;
	channelId: string;
	tenantId: string;
	seq: number;
	authorKind: ActorKind;
	authorId: string;
	body: string;
	addressedToBotId: string | null;
	createdAt: Date;
}

/** What the channel functions read and write. */
export type ChannelDependencies = { store: MessagingStore; ids: IdSource };

const NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

/** Version 5 UUID of `name` in `namespace`, as Python uuid.uuid5 computes it. */
export function uuid5(namespace: string, name: string): string {
	const hash = createHash("sha1")
		.update(Buffer.from(namespace.replace(/-/g, ""), "hex"))
		.update(Buffer.from(name, "utf8"))
		.digest();
	const bytes = Buffer.from(hash.subarray(0, 16));
	bytes[6] = (bytes[6]! & 0x0f) | 0x50;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function pythonJsonString(value: string): string {
	return JSON.stringify(value).replace(/[\u007f-￿]/g, (character) => {
		return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
	});
}

/** The deterministic identifier of the direct channel between one human and one bot in one organization. */
export function directChannelId(tenantId: string, userId: string, botId: string): string {
	const identity = `[${[tenantId, userId, botId].map(pythonJsonString).join(", ")}]`;
	return uuid5(NAMESPACE_URL, `chatticus:direct:${identity}`);
}

/**
 * Open a canonical direct or named channel.
 *
 * Ported from python/src/chatticus/control_plane.py lines 2956-3030. A direct channel is deterministically
 * identified by tenant, human, and bot. A named channel has a stored name and at least two bots.
 *
 * @throws BotNotFoundError If a bot id is unknown.
 * @throws ActorNotInChannelError If a bot belongs to another tenant.
 * @throws InvalidChannelIdentityError If kind, name, or participants are not canonical.
 */
export async function createChannel(
	tenantId: string,
	userId: string,
	botIds: string[],
	options: { kind?: ChannelKind; name?: string | null; idempotencyKey?: string | null },
	deps: ChannelDependencies,
): Promise<Channel> {
	const kind = options.kind ?? "direct";
	const uniqueBotIds = [...new Set(botIds)];
	const normalizedName = options.name === undefined || options.name === null ? null : options.name.trim();
	if (kind === "direct") {
		if (uniqueBotIds.length !== 1 || normalizedName !== null) {
			throw new InvalidChannelIdentityError("A direct channel requires exactly one bot and no name.");
		}
	} else if (kind === "named") {
		if (uniqueBotIds.length < 2 || !normalizedName) {
			throw new InvalidChannelIdentityError("A named channel requires a name and at least two bots.");
		}
	} else {
		throw new InvalidChannelIdentityError(`Unknown channel kind ${pythonRepr(String(kind))}.`);
	}
	const idempotencyKey = options.idempotencyKey ?? null;
	if (idempotencyKey !== null) {
		const cached = await deps.store.getChannelIdempotency(tenantId, idempotencyKey);
		if (cached !== null) {
			return cached;
		}
	}
	const participants: ChannelParticipant[] = [{ kind: "human", actorId: userId }];
	for (const botId of uniqueBotIds) {
		const bot = await botById(tenantId, botId, deps);
		if (bot.tenantId !== tenantId) {
			throw new ActorNotInChannelError(
				`Bot ${pythonRepr(botId)} does not belong to tenant ${pythonRepr(tenantId)}.`,
			);
		}
		participants.push({ kind: "bot", actorId: botId });
	}
	if (kind === "direct") {
		for (const existing of await deps.store.listChannels(tenantId, userId)) {
			const existingBotIds = existing.participants
				.filter((participant) => participant.kind === "bot")
				.map((participant) => participant.actorId);
			if (
				existing.kind === "direct" &&
				existingBotIds.length === uniqueBotIds.length &&
				existingBotIds.every((botId, index) => botId === uniqueBotIds[index])
			) {
				return existing;
			}
		}
	}
	const channelId = kind === "direct" ? directChannelId(tenantId, userId, uniqueBotIds[0]!) : deps.ids.next();
	let channel: Channel = {
		channelId,
		tenantId,
		kind,
		name: normalizedName,
		participants,
		nextSeq: 1,
	};
	if (kind === "direct") {
		channel = await deps.store.putChannelIfAbsent(channel);
	} else {
		await deps.store.putChannel(channel);
	}
	if (idempotencyKey !== null) {
		await deps.store.putChannelIdempotency(tenantId, idempotencyKey, channel);
	}
	return channel;
}

/**
 * Return a channel.
 *
 * Ported from python/src/chatticus/control_plane.py lines 3032-3042.
 *
 * @throws ChannelNotFoundError If the channel is unknown.
 */
export async function getChannel(
	tenantId: string,
	channelId: string,
	deps: { store: MessagingStore },
): Promise<Channel> {
	const record = await deps.store.getChannel(tenantId, channelId);
	if (record === null) {
		throw new ChannelNotFoundError(`Channel ${pythonRepr(channelId)} does not exist.`);
	}
	return record;
}

/** Return channels owned by one household user, ordered by channel id. Ported from control_plane.py lines 858-862. */
export async function listChannels(
	tenantId: string,
	userId: string,
	deps: { store: MessagingStore },
): Promise<Channel[]> {
	const owned = (await deps.store.listChannels(tenantId, userId)).filter((channel) => channel.tenantId === tenantId);
	return owned.sort((left, right) => (left.channelId < right.channelId ? -1 : left.channelId > right.channelId ? 1 : 0));
}

/** The first human participant on a channel. */
export function primaryHumanParticipant(channel: Channel): string {
	for (const participant of channel.participants) {
		if (participant.kind === "human") {
			return participant.actorId;
		}
	}
	throw new ActorNotInChannelError(`Channel ${pythonRepr(channel.channelId)} has no human participants.`);
}

/**
 * Return the channel when the tenant owns it.
 *
 * Ported from python/src/chatticus/control_plane.py lines 3828-3837.
 *
 * @throws ChannelTenantMismatchError If another tenant owns the channel.
 * @throws ChannelNotFoundError If the channel is unknown.
 */
export async function requireChannelTenant(
	channelId: string,
	tenantId: string,
	deps: { store: MessagingStore },
): Promise<Channel> {
	const channel = await deps.store.getChannel(tenantId, channelId);
	if (channel !== null) {
		return channel;
	}
	const owningTenant = await deps.store.resolveChannelTenant(channelId);
	if (owningTenant !== null && owningTenant !== tenantId) {
		throw new ChannelTenantMismatchError(
			`Tenant ${pythonRepr(tenantId)} does not own channel ${pythonRepr(channelId)}.`,
		);
	}
	throw new ChannelNotFoundError(`Channel ${pythonRepr(channelId)} does not exist.`);
}
