import { type DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import type { S3Client } from "@aws-sdk/client-s3";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { AssistantEntry, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { Channel } from "../domain/channels.ts";
import {
	ChannelLogDoc,
	type ChannelLogLine,
	type ChannelMessageDraft,
	attributedWriteEntryDraft,
	readEntryBody,
	readLog,
} from "../pi/channel-log.ts";
import { openOwnerSession } from "../pi/session.ts";
import { IndexedStorage } from "../storage/indexed-storage.ts";
import { storageIdFor } from "../storage/storage-support.ts";
import { formatIsoDateTime } from "../store/codecs/util.ts";
import {
	type LegacyMessage,
	type MigrationScope,
	listLegacyChannels,
	listLegacyMessages,
	transcriptChecksum,
} from "./legacy-layout.ts";
import { readMarker, writeMarker } from "./migration-state.ts";

/** Everything the migration passes read and write. */
export type MigrationDependencies = {
	readonly client: DynamoDBClient;
	readonly s3: S3Client;
	readonly messagingTableName: string;
	readonly conversationsTableName: string;
	readonly bucket: string;
	readonly clock: { now(): Date };
};

/** Which pass is writing: the early repeatable `copy`, or the `delta` inside the write-gate window. */
export type CopyPhase = "copy" | "delta";

/** Provider recorded on the synthetic assistant message of a migrated bot answer. */
export const MIGRATED_PROVIDER = "openai";

/** Model recorded on the synthetic assistant message of a migrated bot answer. */
export const MIGRATED_MODEL = "migrated";

/** Messages committed to one Pi session in a single commit. */
export const MIGRATION_COMMIT_BATCH_SIZE = 25;

/** Channels copied at the same time. */
export const MIGRATION_CHANNEL_CONCURRENCY = 4;

/** The copy of a session did not read back identical to the old transcript. */
export class MigrationVerificationError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "MigrationVerificationError";
	}
}

/**
 * The request id the migration gives the submission record of one message, so a rerun finds it.
 *
 * @param messageId Message.
 * @returns `migrate:<messageId>`.
 */
export const migrationRequestId = (messageId: string): string => `migrate:${messageId}`;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

const timestampOf = (createdAt: string): number => {
	const parsed = Date.parse(createdAt);
	if (Number.isNaN(parsed)) throw new Error(`message created_at is not a timestamp: ${JSON.stringify(createdAt)}`);
	return parsed;
};

/**
 * The synthetic assistant message a bot's own answer becomes in its own session: provider `openai`, model `migrated`,
 * stop reason `stop`, zero usage.
 *
 * @param message The old message.
 * @returns A Pi assistant message.
 */
export const migratedAssistantMessage = (message: LegacyMessage) => ({
	role: "assistant" as const,
	content: [{ type: "text" as const, text: message.body }],
	api: "openai-responses" as const,
	provider: MIGRATED_PROVIDER,
	model: MIGRATED_MODEL,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: ZERO_COST },
	stopReason: "stop" as const,
	timestamp: timestampOf(message.createdAt),
});

/** Whether a message is the answer of the very bot whose session is being written. */
export const isOwnAnswer = (message: LegacyMessage, botId: string): boolean =>
	message.authorKind === "bot" && message.authorId === botId;

const logLineFor = (message: LegacyMessage, entryId: number): ChannelLogLine => ({
	seq: message.seq,
	messageId: message.messageId,
	authorKind: message.authorKind,
	authorId: message.authorId,
	addressedToBotId: message.addressedToBotId,
	createdAt: message.createdAt,
	entryId,
});

const draftOf = (message: LegacyMessage): ChannelMessageDraft => ({
	seq: message.seq,
	messageId: message.messageId,
	authorKind: message.authorKind,
	authorId: message.authorId,
	addressedToBotId: message.addressedToBotId,
	createdAt: message.createdAt,
	body: message.body,
});

/** What one session holds of one channel's old transcript. */
export type SessionCopyReport = {
	botId: string;
	legacyMessages: number;
	alreadyPresent: number;
	/** Messages that were missing from the session when the pass looked. */
	pending: number;
	/** Messages this pass wrote; zero in a dry run. */
	written: number;
	pendingAssistantEntries: number;
	pendingAttributedEntries: number;
	/** Whether a fence was claimed and a commit made. */
	opened: boolean;
};

/** What one channel's pass did or would do. */
export type ChannelCopyReport = {
	tenantId: string;
	channelId: string;
	botIds: string[];
	legacyMessages: number;
	sessions: SessionCopyReport[];
	/** True when the channel has old messages but no bot session to hold them. */
	unservable: boolean;
	dryRun: boolean;
};

/** Options of one copy pass. */
export type CopyOptions = { phase: CopyPhase; dryRun: boolean };

const piPartitionKey = (storageId: string): string => `PI#${storageId}`;

async function sessionExists(deps: MigrationDependencies, storageId: string): Promise<boolean> {
	const result = await deps.client.send(
		new GetItemCommand({
			TableName: deps.conversationsTableName,
			Key: { pk: { S: piPartitionKey(storageId) }, sk: { S: "META" } },
			ConsistentRead: true,
		}),
	);
	return result.Item !== undefined;
}

/** One message as a session shows it: its log line and the body read from the entry the line points at. */
export type SessionMessage = ChannelLogLine & { body: string };

/**
 * Read a session's channel log and the bodies it points at without owning the session and without creating it.
 *
 * @param deps Clients and tables.
 * @param tenantId Organization.
 * @param botId Bot.
 * @param channelId Channel.
 * @returns The messages in log order; empty when the session does not exist yet.
 */
export async function readSessionMessages(
	deps: MigrationDependencies,
	tenantId: string,
	botId: string,
	channelId: string,
): Promise<SessionMessage[]> {
	const storageId = storageIdFor(tenantId, botId, channelId);
	if (!(await sessionExists(deps, storageId))) return [];
	const storage = await IndexedStorage.open({
		client: deps.client,
		s3: deps.s3,
		tableName: deps.conversationsTableName,
		bucket: deps.bucket,
		storageId,
	});
	const lines = await readLog(storage);
	return Promise.all(
		lines.map(async (line) => ({ ...line, body: (await readEntryBody(storage, line.entryId)) ?? "" })),
	);
}

/** The checksum of a session's messages, comparable to `transcriptChecksum` of the old transcript. */
export const sessionChecksum = (messages: readonly SessionMessage[]): string =>
	transcriptChecksum(
		[...messages]
			.sort((left, right) => left.seq - right.seq)
			.map((message) => ({
				seq: message.seq,
				messageId: message.messageId,
				authorKind: message.authorKind,
				authorId: message.authorId,
				body: message.body,
				addressedToBotId: message.addressedToBotId,
				createdAt: message.createdAt,
			})),
	);

async function writePending(
	deps: MigrationDependencies,
	tenantId: string,
	botId: string,
	channelId: string,
	pending: readonly LegacyMessage[],
): Promise<void> {
	const owner = await openOwnerSession(storageIdFor(tenantId, botId, channelId), {
		client: deps.client,
		s3: deps.s3,
		tableName: deps.conversationsTableName,
		bucket: deps.bucket,
		models: createModels(),
		extensions: [],
		context: BACKGROUND_CONTEXT,
	});
	try {
		await owner.harness.root(BACKGROUND_CONTEXT);
		for (let start = 0; start < pending.length; start += MIGRATION_COMMIT_BATCH_SIZE) {
			const batch = pending.slice(start, start + MIGRATION_COMMIT_BATCH_SIZE);
			await owner.harness.commit(async (tx) => {
				const log = await tx.doc(ChannelLogDoc, ROOT_CONVERSATION_ID);
				const known = new Set(log.lines.map((line) => line.messageId));
				for (const message of batch) {
					if (known.has(message.messageId)) continue;
					const entry = isOwnAnswer(message, botId)
						? await tx.appendEntry(AssistantEntry, ROOT_CONVERSATION_ID, { model: [migratedAssistantMessage(message)] })
						: await tx.appendEntry(ROOT_CONVERSATION_ID, attributedWriteEntryDraft(draftOf(message)));
					await tx.createSubmission({
						type: "write",
						conversationId: ROOT_CONVERSATION_ID,
						requestId: migrationRequestId(message.messageId),
						status: "done",
						entry: entry.id,
					});
					log.lines.push(logLineFor(message, entry.id));
				}
			}, BACKGROUND_CONTEXT);
		}
	} finally {
		await owner.close();
	}
}

async function copySession(
	deps: MigrationDependencies,
	channel: Channel,
	botId: string,
	legacy: readonly LegacyMessage[],
	options: CopyOptions,
): Promise<SessionCopyReport> {
	const held = await readSessionMessages(deps, channel.tenantId, botId, channel.channelId);
	const present = new Set(held.map((message) => message.messageId));
	const pending = legacy.filter((message) => !present.has(message.messageId));
	const report: SessionCopyReport = {
		botId,
		legacyMessages: legacy.length,
		alreadyPresent: legacy.length - pending.length,
		pending: pending.length,
		written: 0,
		pendingAssistantEntries: pending.filter((message) => isOwnAnswer(message, botId)).length,
		pendingAttributedEntries: pending.filter((message) => !isOwnAnswer(message, botId)).length,
		opened: false,
	};
	if (options.dryRun) return report;
	if (pending.length > 0) {
		await writePending(deps, channel.tenantId, botId, channel.channelId, pending);
		report.written = pending.length;
		report.opened = true;
	}
	const marker = await readMarker(deps.client, deps.messagingTableName, channel.tenantId, botId, channel.channelId);
	const expected = transcriptChecksum(legacy);
	const after = pending.length > 0 ? await readSessionMessages(deps, channel.tenantId, botId, channel.channelId) : held;
	const legacyIds = new Set(legacy.map((message) => message.messageId));
	const copied = after.filter((message) => legacyIds.has(message.messageId));
	const actual = sessionChecksum(copied);
	if (copied.length !== legacy.length || actual !== expected) {
		throw new MigrationVerificationError(
			`session of bot ${botId} in channel ${channel.channelId} holds ${copied.length} of ${legacy.length} old messages ` +
				`and does not match the old transcript (checksum ${actual} against ${expected})`,
		);
	}
	const lastSeq = legacy.length === 0 ? 0 : legacy[legacy.length - 1]!.seq;
	if (marker === null || pending.length > 0 || marker.checksum !== expected) {
		await writeMarker(deps.client, deps.messagingTableName, {
			tenantId: channel.tenantId,
			channelId: channel.channelId,
			botId,
			lastSeq,
			messageCount: legacy.length,
			checksum: expected,
			phase: options.phase,
			updatedAt: formatIsoDateTime(deps.clock.now()),
		});
	}
	return report;
}

/**
 * Copy one channel's old transcript into the Pi session of every bot participant, in sequence order. Idempotent and
 * resumable: a session that already holds a message is left alone, a session with nothing missing is not even opened
 * (no fence is claimed), and a pass that stopped halfway continues where it stopped. After the writes the session is read
 * back and compared by checksum with the old items.
 *
 * @param deps Clients and tables.
 * @param channel The channel.
 * @param options The phase label and whether to only report.
 * @returns What each session held and what was written.
 * @throws MigrationVerificationError When a session does not read back identical to the old transcript.
 */
export async function copyChannel(
	deps: MigrationDependencies,
	channel: Channel,
	options: CopyOptions,
): Promise<ChannelCopyReport> {
	const legacy = await listLegacyMessages(
		{ client: deps.client, tableName: deps.messagingTableName },
		channel.tenantId,
		channel.channelId,
	);
	const botIds = channel.participants.filter((participant) => participant.kind === "bot").map((participant) => participant.actorId);
	const sessions: SessionCopyReport[] = [];
	for (const botId of botIds) {
		sessions.push(await copySession(deps, channel, botId, legacy, options));
	}
	return {
		tenantId: channel.tenantId,
		channelId: channel.channelId,
		botIds,
		legacyMessages: legacy.length,
		sessions,
		unservable: botIds.length === 0 && legacy.length > 0,
		dryRun: options.dryRun,
	};
}

async function mapWithConcurrency<Input, Output>(
	inputs: readonly Input[],
	limit: number,
	work: (input: Input) => Promise<Output>,
): Promise<Output[]> {
	const results: Output[] = new Array(inputs.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, inputs.length) }, async () => {
		while (next < inputs.length) {
			const index = next;
			next += 1;
			results[index] = await work(inputs[index]!);
		}
	});
	await Promise.all(workers);
	return results;
}

/**
 * Copy every channel in scope. A channel that fails verification does not stop the others; its error is returned.
 *
 * @param deps Clients and tables.
 * @param scope Tenant and channel filter.
 * @param options Phase label and dry-run flag.
 * @returns One entry per channel: its report, or the error that stopped it.
 */
export async function copyAllChannels(
	deps: MigrationDependencies,
	scope: MigrationScope,
	options: CopyOptions,
): Promise<Array<{ tenantId: string; channelId: string; report: ChannelCopyReport | null; error: Error | null }>> {
	const channels = await listLegacyChannels({ client: deps.client, tableName: deps.messagingTableName }, scope);
	return mapWithConcurrency(channels, MIGRATION_CHANNEL_CONCURRENCY, async (channel) => {
		try {
			return { tenantId: channel.tenantId, channelId: channel.channelId, report: await copyChannel(deps, channel, options), error: null };
		} catch (error) {
			return {
				tenantId: channel.tenantId,
				channelId: channel.channelId,
				report: null,
				error: error instanceof Error ? error : new Error(String(error)),
			};
		}
	});
}
