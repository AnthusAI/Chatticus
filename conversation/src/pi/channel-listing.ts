import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { MessageOrigin } from "../domain/channels.ts";
import type { S3Client } from "@aws-sdk/client-s3";
import { type CommitObjectCache, IndexedStorage } from "../storage/indexed-storage.ts";
import { storageIdFor } from "../storage/storage-support.ts";
import type { Storage } from "@earendil-works/pi-durable";
import { type ChannelLogLine, readEntryBody, readLog } from "./channel-log.ts";
import { list as listMailbox, type MailboxStore } from "./mailbox.ts";
import { fitActivityBudget, readTurnActivity, type ToolActivityItem } from "./message-activity.ts";

export type ChannelListingDependencies = {
	readonly client: DynamoDBClient;
	readonly s3: S3Client;
	readonly messagingTableName: string;
	readonly conversationsTableName: string;
	readonly bucket: string;
	/** Shared cache of immutable Pi commit objects, see MessageBodyCache. */
	readonly commitCache?: CommitObjectCache;
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
	/** Where the message came from when it arrived over an external transport; absent means the web app. */
	origin?: MessageOrigin;
	/** The tool calls of the turn a bot message ends; absent when the turn used no tool or the message is not a bot answer. */
	activity?: ToolActivityItem[];
};

type SessionRead = { storage: Storage; lines: ChannelLogLine[] };

const authoritative = (candidate: { line: ChannelLogLine; botId: string }, current: { line: ChannelLogLine; botId: string }) =>
	candidate.line.authorKind === "bot" && candidate.line.authorId === candidate.botId && current.line.authorId !== current.botId;

/**
 * Serve a channel's messages by merging, for every participating bot session, its channel log and its mailbox. Sessions
 * are read without owning or creating them: a bot with no session yet contributes only its mailbox. A message in
 * several sessions appears once, a bot's reply is taken from its author's session, and a mailbox item counts only
 * until it is drained into a session. Bodies are fetched only for sequences after `afterSeq`.
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
	const bySeq = new Map<number, { listed: Omit<ListedMessage, "body" | "activity">; body: Promise<string>; line?: ChannelLogLine; botId: string; session?: SessionRead }>();
	for (const botId of botIds) {
		const storage = await IndexedStorage.openExisting({
			client: dependencies.client,
			s3: dependencies.s3,
			tableName: dependencies.conversationsTableName,
			bucket: dependencies.bucket,
			storageId: storageIdFor(tenantId, botId, channelId),
			commitCache: dependencies.commitCache,
		});
		const allLines = storage === undefined ? [] : await readLog(storage);
		const session = storage === undefined ? undefined : { storage, lines: allLines };
		const logged =
			storage === undefined
				? []
				: allLines
						.filter((line) => line.seq > afterSeq)
						.map((line) => ({ line, body: () => readEntryBody(storage, line.entryId) }));
		for (const { line, body } of logged) {
			const current = bySeq.get(line.seq);
			if (current?.line !== undefined && !authoritative({ line, botId }, { line: current.line, botId: current.botId })) continue;
			bySeq.set(line.seq, {
				line,
				botId,
				session,
				listed: {
					message_id: line.messageId,
					channel_id: channelId,
					tenant_id: tenantId,
					seq: line.seq,
					author_kind: line.authorKind,
					author_id: line.authorId,
					addressed_to_bot_id: line.addressedToBotId,
					created_at: line.createdAt,
					...(line.origin === undefined ? {} : { origin: line.origin }),
				},
				body: body().then((text) => text ?? ""),
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
					...(item.origin === undefined ? {} : { origin: item.origin }),
				},
				body: Promise.resolve(item.body),
			});
		}
	}
	const ordered = [...bySeq.values()].sort((left, right) => left.listed.seq - right.listed.seq);
	const activities = fitActivityBudget(await Promise.all(ordered.map((entry) => activityOf(entry))));
	return Promise.all(
		ordered.map(async (entry, index) => {
			const activity = activities[index];
			return { ...entry.listed, body: await entry.body, ...(activity === undefined ? {} : { activity }) };
		}),
	);
}

const activityOf = async (entry: {
	line?: ChannelLogLine;
	botId: string;
	session?: SessionRead;
}): Promise<ToolActivityItem[] | undefined> => {
	const { line, session } = entry;
	if (line === undefined || session === undefined) return undefined;
	if (line.authorKind !== "bot" || line.authorId !== entry.botId) return undefined;
	const previousAnswer = session.lines
		.filter((candidate) => candidate.authorKind === "bot" && candidate.authorId === entry.botId && candidate.entryId < line.entryId)
		.reduce((newest, candidate) => Math.max(newest, candidate.entryId), 0);
	const activity = await readTurnActivity(session.storage, previousAnswer, line.entryId);
	return activity.length === 0 ? undefined : activity;
};
