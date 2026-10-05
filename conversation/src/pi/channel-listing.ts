import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { S3Client } from "@aws-sdk/client-s3";
import { IndexedStorage } from "../storage/indexed-storage.ts";
import { storageIdFor } from "../storage/storage-support.ts";
import { type ChannelLogLine, readEntryBody, readLog } from "./channel-log.ts";
import { list as listMailbox, type MailboxStore } from "./mailbox.ts";

export type ChannelListingDependencies = {
	readonly client: DynamoDBClient;
	readonly s3: S3Client;
	readonly messagingTableName: string;
	readonly conversationsTableName: string;
	readonly bucket: string;
};

export type ListedMessage = {
	message_id: string;
	channel_id: string;
	tenant_id: string;
	seq: number;
	author_kind: string;
	author_id: string;
	body: string;
	addressed_to_bot_id: string | null;
	created_at: string;
};

const authoritative = (candidate: { line: ChannelLogLine; botId: string }, current: { line: ChannelLogLine; botId: string }) =>
	candidate.line.authorKind === "bot" && candidate.line.authorId === candidate.botId && current.line.authorId !== current.botId;

/**
 * Serve a channel's messages by merging, for every participating bot session, its channel log and its mailbox. Sessions
 * are read without owning them. A message in several sessions appears once, a bot's reply is taken from its author's
 * session, and a mailbox item counts only until it is drained into a session. Bodies are fetched only for sequences
 * after `afterSeq`.
 *
 * @param dependencies Clients, tables and bucket.
 * @param tenantId Organization.
 * @param channelId Channel.
 * @param botIds Participating bots.
 * @param afterSeq Only messages with a greater sequence.
 * @returns Messages ordered by sequence.
 */
export async function listChannelMessages(
	dependencies: ChannelListingDependencies,
	tenantId: string,
	channelId: string,
	botIds: readonly string[],
	afterSeq = 0,
): Promise<ListedMessage[]> {
	const mailboxStore: MailboxStore = { client: dependencies.client, tableName: dependencies.messagingTableName };
	const bySeq = new Map<number, { listed: Omit<ListedMessage, "body">; body: Promise<string>; line?: ChannelLogLine; botId: string }>();
	for (const botId of botIds) {
		const storage = await IndexedStorage.open({
			client: dependencies.client,
			s3: dependencies.s3,
			tableName: dependencies.conversationsTableName,
			bucket: dependencies.bucket,
			storageId: storageIdFor(tenantId, botId, channelId),
		});
		const lines = (await readLog(storage)).filter((line) => line.seq > afterSeq);
		for (const line of lines) {
			const current = bySeq.get(line.seq);
			if (current?.line !== undefined && !authoritative({ line, botId }, { line: current.line, botId: current.botId })) continue;
			bySeq.set(line.seq, {
				line,
				botId,
				listed: {
					message_id: line.messageId,
					channel_id: channelId,
					tenant_id: tenantId,
					seq: line.seq,
					author_kind: line.authorKind,
					author_id: line.authorId,
					addressed_to_bot_id: line.addressedToBotId,
					created_at: line.createdAt,
				},
				body: readEntryBody(storage, line.entryId).then((body) => body ?? ""),
			});
		}
		for (const item of await listMailbox(mailboxStore, tenantId, botId, channelId, afterSeq)) {
			if (bySeq.has(item.seq)) continue;
			bySeq.set(item.seq, {
				botId,
				listed: {
					message_id: item.messageId,
					channel_id: channelId,
					tenant_id: tenantId,
					seq: item.seq,
					author_kind: item.authorKind,
					author_id: item.authorId,
					addressed_to_bot_id: item.addressedToBotId,
					created_at: item.createdAt,
				},
				body: Promise.resolve(item.body),
			});
		}
	}
	const ordered = [...bySeq.values()].sort((left, right) => left.listed.seq - right.listed.seq);
	return Promise.all(ordered.map(async (entry) => ({ ...entry.listed, body: await entry.body })));
}
