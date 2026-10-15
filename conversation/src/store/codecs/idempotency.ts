/**
 * Codecs for Idempotency items (post and bot).
 * Ported from python/src/chatticus/messaging/store.py lines 1813-1907, 2878-2913.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb";

export interface Idempotency {
	pk: string;
	sk: string;
	tenantId: string;
	channelId: string;
	messageId: string;
	seq: number;
	authorKind: string;
	authorId: string;
	body: string;
	addressedToBotId?: string;
	createdAt: string;
	turnId?: string;
}

export type Item = Record<string, AttributeValue>;

/**
 * Encode an Idempotency to a DynamoDB item.
 * @param value Idempotency to encode.
 * @returns DynamoDB item.
 */
export function encode(value: Idempotency): Item {
	const item: Item = {
		pk: { S: value.pk },
		sk: { S: value.sk },
		tenant_id: { S: value.tenantId },
		channel_id: { S: value.channelId },
		message_id: { S: value.messageId },
		seq: { N: String(value.seq) },
		author_kind: { S: value.authorKind },
		author_id: { S: value.authorId },
		body: { S: value.body },
		addressed_to_bot_id: { S: value.addressedToBotId ?? "" },
		created_at: { S: value.createdAt },
	};

	if (value.turnId !== undefined) {
		item.turn_id = { S: value.turnId };
	}

	return item;
}

/**
 * Decode an Idempotency from a DynamoDB item.
 * @param item DynamoDB item.
 * @returns Decoded Idempotency.
 * @throws Error if required attributes are missing.
 */
export function decode(item: Item): Idempotency {
	const pk = item.pk?.S;
	if (!pk) {
		throw new Error("malformed idempotency item: pk");
	}

	const sk = item.sk?.S;
	if (!sk) {
		throw new Error("malformed idempotency item: sk");
	}

	const tenantId = item.tenant_id?.S;
	if (!tenantId) {
		throw new Error("malformed idempotency item: tenant_id");
	}

	const channelId = item.channel_id?.S;
	if (!channelId) {
		throw new Error("malformed idempotency item: channel_id");
	}

	const messageId = item.message_id?.S;
	if (!messageId) {
		throw new Error("malformed idempotency item: message_id");
	}

	const seqStr = item.seq?.N;
	if (!seqStr) {
		throw new Error("malformed idempotency item: seq");
	}

	const authorKind = item.author_kind?.S;
	if (!authorKind) {
		throw new Error("malformed idempotency item: author_kind");
	}

	const authorId = item.author_id?.S;
	if (!authorId) {
		throw new Error("malformed idempotency item: author_id");
	}

	const body = item.body?.S;
	if (!body) {
		throw new Error("malformed idempotency item: body");
	}

	const createdAt = item.created_at?.S;
	if (!createdAt) {
		throw new Error("malformed idempotency item: created_at");
	}

	const addressedToBotId = item.addressed_to_bot_id?.S || undefined;

	return {
		pk,
		sk,
		tenantId,
		channelId,
		messageId,
		seq: Number(seqStr),
		authorKind,
		authorId,
		body,
		addressedToBotId,
		createdAt,
		turnId: item.turn_id?.S,
	};
}
