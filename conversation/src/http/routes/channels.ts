import type { Context } from "hono";
import {
	ChannelNotFoundError,
	createChannel,
	getChannel,
	listChannels,
	primaryHumanParticipant,
} from "../../domain/channels.ts";
import type { Channel, ChannelKind } from "../../domain/channels.ts";
import type { MessagingStore } from "../../store/messaging-store.ts";
import type { IdSource } from "../app.ts";
import { isRefusal, pathParameter, resolveUserPrincipal, type UserPrincipalDependencies } from "../user-principal.ts";

/** Everything the channel routes depend on. */
export interface ChannelRouteDependencies extends UserPrincipalDependencies {
	store: MessagingStore;
	ids: IdSource;
}

/** One channel as the HTTP API renders it. */
export interface ChannelPayload {
	channel_id: string;
	tenant_id: string;
	user_id: string;
	kind: string;
	name: string | null;
	participants: Array<{ kind: string; actor_id: string }>;
}

/** Render a channel for the HTTP API. */
export function channelPayload(channel: Channel): ChannelPayload {
	return {
		channel_id: channel.channelId,
		tenant_id: channel.tenantId,
		user_id: primaryHumanParticipant(channel),
		kind: channel.kind,
		name: channel.name,
		participants: channel.participants.map((participant) => ({
			kind: participant.kind,
			actor_id: participant.actorId,
		})),
	};
}

type CreateChannelBody = { user_id: string; bot_ids: string[]; kind: ChannelKind; name: string | null };

function parseCreateChannelBody(raw: unknown): CreateChannelBody | null {
	if (typeof raw !== "object" || raw === null) {
		return null;
	}
	const body = raw as Record<string, unknown>;
	if (typeof body.user_id !== "string") {
		return null;
	}
	if (!Array.isArray(body.bot_ids) || !body.bot_ids.every((botId) => typeof botId === "string")) {
		return null;
	}
	if (body.kind !== "direct" && body.kind !== "named") {
		return null;
	}
	if (body.name !== null && typeof body.name !== "string") {
		return null;
	}
	return { user_id: body.user_id, bot_ids: body.bot_ids as string[], kind: body.kind, name: body.name as string | null };
}

/** POST /orgs/{tenant_id}/channels: open a canonical direct or named channel, replaying an Idempotency-Key. */
export async function createChannelHandler(c: Context, deps: ChannelRouteDependencies): Promise<Response> {
	const principal = await resolveUserPrincipal(c, deps);
	if (isRefusal(principal)) {
		return principal;
	}
	const body = parseCreateChannelBody(await c.req.json().catch(() => null));
	if (body === null) {
		return c.json({ detail: "user_id, bot_ids, kind and name are required" }, 422);
	}
	const idempotencyKey = (c.req.header("Idempotency-Key") ?? "").trim() || null;
	const channel = await createChannel(
		pathParameter(c, "tenant_id"),
		body.user_id,
		body.bot_ids,
		{ kind: body.kind, name: body.name, idempotencyKey },
		deps,
	);
	return c.json(channelPayload(channel), 200);
}

/** GET /orgs/{tenant_id}/users/{user_id}/channels: the channels one user takes part in. */
export async function listUserChannelsHandler(c: Context, deps: ChannelRouteDependencies): Promise<Response> {
	const principal = await resolveUserPrincipal(c, deps);
	if (isRefusal(principal)) {
		return principal;
	}
	const channels = await listChannels(pathParameter(c, "tenant_id"), pathParameter(c, "user_id"), deps);
	return c.json({ channels: channels.map(channelPayload) }, 200);
}

/** GET /orgs/{tenant_id}/channels/{channel_id}: one channel by identifier. */
export async function getChannelHandler(c: Context, deps: ChannelRouteDependencies): Promise<Response> {
	const principal = await resolveUserPrincipal(c, deps);
	if (isRefusal(principal)) {
		return principal;
	}
	try {
		return c.json(channelPayload(await getChannel(pathParameter(c, "tenant_id"), pathParameter(c, "channel_id"), deps)), 200);
	} catch (error) {
		if (error instanceof ChannelNotFoundError) {
			return c.json({ detail: "channel not found" }, 404);
		}
		throw error;
	}
}
