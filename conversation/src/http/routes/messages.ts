import type { Context } from "hono";
import { listMessages, type Message, type MessageDependencies, postMessage } from "../../domain/messages.ts";
import type { ActorKind } from "../../domain/channels.ts";
import { isRefusal, pathParameter, resolveUserPrincipal, type UserPrincipalDependencies } from "../user-principal.ts";

/** Everything the message routes depend on. */
export interface MessageRouteDependencies extends UserPrincipalDependencies {
	messages: MessageDependencies;
}

/** One message as the HTTP API renders it. */
export interface MessagePayload {
	message_id: string;
	channel_id: string;
	tenant_id: string;
	seq: number;
	author_kind: string;
	author_id: string;
	body: string;
	addressed_to_bot_id: string | null;
	created_at: string;
}

/** Render a message for the HTTP API. */
export function messagePayload(message: Message): MessagePayload {
	return {
		message_id: message.messageId,
		channel_id: message.channelId,
		tenant_id: message.tenantId,
		seq: message.seq,
		author_kind: message.authorKind,
		author_id: message.authorId,
		body: message.body,
		addressed_to_bot_id: message.addressedToBotId,
		created_at: message.createdAt.toISOString(),
	};
}

type PostMessageBody = {
	authorKind: ActorKind;
	authorId: string;
	body: string;
	addressedToBotId: string | null;
	enqueueTurn: boolean;
};

function parsePostMessageBody(raw: unknown): PostMessageBody | null {
	if (typeof raw !== "object" || raw === null) {
		return null;
	}
	const body = raw as Record<string, unknown>;
	if (body.author_kind !== "human" && body.author_kind !== "bot") {
		return null;
	}
	if (typeof body.author_id !== "string" || typeof body.body !== "string") {
		return null;
	}
	const addressed = body.addressed_to_bot_id ?? null;
	if (addressed !== null && typeof addressed !== "string") {
		return null;
	}
	const enqueueTurn = body.enqueue_turn ?? true;
	if (typeof enqueueTurn !== "boolean") {
		return null;
	}
	return {
		authorKind: body.author_kind,
		authorId: body.author_id,
		body: body.body,
		addressedToBotId: addressed,
		enqueueTurn,
	};
}

/**
 * POST /orgs/{tenant_id}/channels/{channel_id}/messages: admit a message. Answers the message and the turn it started
 * or joined, replaying an Idempotency-Key.
 */
export async function postChannelMessageHandler(c: Context, deps: MessageRouteDependencies): Promise<Response> {
	const principal = await resolveUserPrincipal(c, deps);
	if (isRefusal(principal)) {
		return principal;
	}
	const body = parsePostMessageBody(await c.req.json().catch(() => null));
	if (body === null) {
		return c.json({ detail: "author_kind, author_id and body are required" }, 422);
	}
	const result = await postMessage(deps.messages, {
		tenantId: pathParameter(c, "tenant_id"),
		channelId: pathParameter(c, "channel_id"),
		authorKind: body.authorKind,
		authorId: body.authorId,
		body: body.body,
		addressedToBotId: body.addressedToBotId,
		idempotencyKey: (c.req.header("Idempotency-Key") ?? "").trim() || null,
		enqueueTurn: body.enqueueTurn,
	});
	return c.json({ message: messagePayload(result.message), turn_id: result.turnId }, 200);
}

/** GET /orgs/{tenant_id}/channels/{channel_id}/messages?after=: committed messages after a sequence. */
export async function listChannelMessagesHandler(c: Context, deps: MessageRouteDependencies): Promise<Response> {
	const principal = await resolveUserPrincipal(c, deps);
	if (isRefusal(principal)) {
		return principal;
	}
	const after = Number(c.req.query("after") ?? "0");
	if (!Number.isInteger(after) || after < 0) {
		return c.json({ detail: "after must be a non-negative integer" }, 422);
	}
	const messages = await listMessages(deps.messages, {
		tenantId: pathParameter(c, "tenant_id"),
		channelId: pathParameter(c, "channel_id"),
		afterSeq: after,
	});
	return c.json({ messages: messages.map(messagePayload) }, 200);
}
