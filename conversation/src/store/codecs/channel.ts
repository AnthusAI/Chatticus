/**
 * Codecs for Channel meta items and the channel messages that share their partition.
 * Ported from python/src/chatticus/messaging/store.py lines 1166-1230, 2878-2913.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import type { ActorKind, Channel, ChannelKind, ChannelMessageRecord, MessageOrigin } from "../../domain/channels.ts";
import { MessageBodyTooLargeError } from "../../http/errors.ts";
import type { ToolActivityItem } from "../../pi/message-activity.ts";
import { formatIsoDateTime, stringifyPythonStyle } from "./util.ts";
import { requireString } from "./list-util.ts";

export type Item = Record<string, AttributeValue>;

/** Sort key of the committed message with the given sequence. */
export function messageSortKey(seq: number): string {
	return `msg#${String(seq).padStart(10, "0")}`;
}

/** Encode a channel as its meta item. */
export function encodeChannel(channel: Channel): Item {
	const item: Item = {
		pk: { S: `${channel.tenantId}#channel#${channel.channelId}` },
		sk: { S: "meta" },
		tenant_id: { S: channel.tenantId },
		channel_id: { S: channel.channelId },
		kind: { S: channel.kind },
		next_seq: { N: String(channel.nextSeq) },
		participants: {
			S: stringifyPythonStyle(
				channel.participants.map((participant) => ({ kind: participant.kind, actor_id: participant.actorId })),
			),
		},
	};
	if (channel.name !== null) {
		item.name = { S: channel.name };
	}
	return item;
}

/** Decode a channel meta item. */
export function decodeChannel(item: Item): Channel {
	const participants = JSON.parse(requireString(item, "participants", "channel")) as Array<{
		kind: ActorKind;
		actor_id: string;
	}>;
	const nextSeq = item.next_seq?.N;
	if (nextSeq === undefined) {
		throw new Error("malformed channel item: next_seq");
	}
	return {
		channelId: requireString(item, "channel_id", "channel"),
		tenantId: requireString(item, "tenant_id", "channel"),
		kind: requireString(item, "kind", "channel") as ChannelKind,
		name: item.name?.S ?? null,
		participants: participants.map((row) => ({ kind: row.kind, actorId: row.actor_id })),
		nextSeq: Number(nextSeq),
	};
}

/** The most UTF-8 bytes a message body may hold inline in its record row; DynamoDB items stop at 400 KB with the activity and the origin. */
export const MESSAGE_BODY_INLINE_BYTES = 250_000;

/** The most UTF-8 bytes of one continuation item of a longer body. */
export const MESSAGE_BODY_PART_BYTES = 300_000;

/** The longest message body the record keeps, in UTF-8 bytes. A longer one is refused with status 413. */
export const MESSAGE_BODY_MAX_BYTES = 2_000_000;

export { MessageBodyTooLargeError };

/** The sort key of one continuation item of a long body: it sorts right after its row and before the next message. */
export function messagePartSortKey(seq: number, part: number): string {
	return `${messageSortKey(seq)}#p${String(part).padStart(4, "0")}`;
}

/**
 * Cut a body into pieces of at most `limit` UTF-8 bytes, never inside a character.
 *
 * @param body The text.
 * @param limit Bytes per piece.
 * @returns The pieces, in order; one piece when the body fits.
 */
export function splitBody(body: string, limit: number): string[] {
	const pieces: string[] = [];
	let current = "";
	let bytes = 0;
	for (const character of body) {
		const size = Buffer.byteLength(character, "utf8");
		if (bytes + size > limit) {
			pieces.push(current);
			current = "";
			bytes = 0;
		}
		current += character;
		bytes += size;
	}
	pieces.push(current);
	return pieces;
}

/**
 * Encode one committed message as its row and, for a body longer than a row holds, the continuation items that carry the
 * rest. Write the items before the row, so a reader never sees a row whose body is not all there.
 *
 * @throws MessageBodyTooLargeError If the body is longer than {@link MESSAGE_BODY_MAX_BYTES}.
 */
export function encodeMessageItems(message: ChannelMessageRecord): { row: Item; parts: Item[] } {
	const bytes = Buffer.byteLength(message.body, "utf8");
	if (bytes > MESSAGE_BODY_MAX_BYTES) {
		throw new MessageBodyTooLargeError(`A message body of ${bytes} bytes exceeds the ${MESSAGE_BODY_MAX_BYTES} bytes a channel record keeps.`);
	}
	const row = encodeMessage(message);
	if (bytes <= MESSAGE_BODY_INLINE_BYTES) return { row, parts: [] };
	const pieces = splitBody(message.body, MESSAGE_BODY_PART_BYTES);
	row.body = { S: "" };
	row.body_parts = { N: String(pieces.length) };
	const partition = row.pk!;
	return {
		row,
		parts: pieces.map((piece, index) => ({
			pk: partition,
			sk: { S: messagePartSortKey(message.seq, index + 1) },
			body: { S: piece },
		})),
	};
}

/** Encode the row of one committed message, with its body inline. */
export function encodeMessage(message: ChannelMessageRecord): Item {
	const item: Item = {
		pk: { S: `${message.tenantId}#channel#${message.channelId}` },
		sk: { S: messageSortKey(message.seq) },
		tenant_id: { S: message.tenantId },
		channel_id: { S: message.channelId },
		message_id: { S: message.messageId },
		seq: { N: String(message.seq) },
		author_kind: { S: message.authorKind },
		author_id: { S: message.authorId },
		body: { S: message.body },
		addressed_to_bot_id: { S: message.addressedToBotId ?? "" },
		created_at: { S: formatIsoDateTime(message.createdAt) },
	};
	if (message.origin !== undefined) item.origin = { S: JSON.stringify(message.origin) };
	if (message.activity !== undefined) item.activity = { S: JSON.stringify(message.activity) };
	if (message.inReplyToSeq !== undefined) item.in_reply_to_seq = { N: String(message.inReplyToSeq) };
	if (message.deletedAt !== undefined) item.deleted_at = { S: formatIsoDateTime(message.deletedAt) };
	return item;
}

/** Decode one committed message. */
export function decodeMessage(item: Item, parts: readonly Item[] = []): ChannelMessageRecord {
	return {
		messageId: requireString(item, "message_id", "message"),
		channelId: requireString(item, "channel_id", "message"),
		tenantId: requireString(item, "tenant_id", "message"),
		seq: Number(item.seq?.N),
		authorKind: requireString(item, "author_kind", "message") as ActorKind,
		authorId: requireString(item, "author_id", "message"),
		body: parts.length === 0 ? (item.body?.S ?? "") : parts.map((part) => part.body?.S ?? "").join(""),
		addressedToBotId: item.addressed_to_bot_id?.S || null,
		createdAt: new Date(requireString(item, "created_at", "message")),
		...(item.origin?.S === undefined ? {} : { origin: JSON.parse(item.origin.S) as MessageOrigin }),
		...(item.activity?.S === undefined ? {} : { activity: JSON.parse(item.activity.S) as ToolActivityItem[] }),
		...(item.in_reply_to_seq?.N === undefined ? {} : { inReplyToSeq: Number(item.in_reply_to_seq.N) }),
		...(item.deleted_at?.S === undefined ? {} : { deletedAt: new Date(item.deleted_at.S) }),
	};
}
