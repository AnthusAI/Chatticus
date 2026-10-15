/**
 * Codecs for Channel meta items and the channel messages that share their partition.
 * Ported from python/src/chatticus/messaging/store.py lines 1166-1230, 2878-2913.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import type { ActorKind, Channel, ChannelKind, ChannelMessageRecord } from "../../domain/channels.ts";
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

/** Encode one committed message. */
export function encodeMessage(message: ChannelMessageRecord): Item {
	return {
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
}

/** Decode one committed message. */
export function decodeMessage(item: Item): ChannelMessageRecord {
	return {
		messageId: requireString(item, "message_id", "message"),
		channelId: requireString(item, "channel_id", "message"),
		tenantId: requireString(item, "tenant_id", "message"),
		seq: Number(item.seq?.N),
		authorKind: requireString(item, "author_kind", "message") as ActorKind,
		authorId: requireString(item, "author_id", "message"),
		body: item.body?.S ?? "",
		addressedToBotId: item.addressed_to_bot_id?.S || null,
		createdAt: new Date(requireString(item, "created_at", "message")),
	};
}
