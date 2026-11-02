import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { AssistantEntry, type Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { ChannelMessageRecord } from "../domain/channels.ts";
import { migratedAssistantMessage } from "../migration/copy.ts";
import { storageIdFor } from "../storage/storage-support.ts";
import { ChannelLogDoc, attributedWriteEntryDraft } from "./channel-log.ts";
import { openOwnerSession, type OwnerStorageDependencies } from "./session.ts";

/** Messages committed to one rebuilt session in a single commit. */
export const REBUILD_COMMIT_BATCH_SIZE = 25;

type Committer = Pick<Harness, "commit">;

/**
 * Write record messages into an open session as the rebuild does: other authors as attributed user-role entries, the bot's
 * own answers as synthetic assistant entries. A message the session already holds is skipped.
 *
 * @param harness The owner's harness over the session.
 * @param botId The bot whose session it is.
 * @param messages The record rows to write, oldest first.
 * @returns How many messages were written.
 */
export async function writeRecordMessages(harness: Committer, botId: string, messages: readonly ChannelMessageRecord[]): Promise<number> {
	let written = 0;
	for (let start = 0; start < messages.length; start += REBUILD_COMMIT_BATCH_SIZE) {
		const batch = messages.slice(start, start + REBUILD_COMMIT_BATCH_SIZE);
		await harness.commit(async (tx) => {
			const log = await tx.doc(ChannelLogDoc, ROOT_CONVERSATION_ID);
			const known = new Set(log.lines.map((line) => line.messageId));
			for (const message of batch) {
				if (known.has(message.messageId)) continue;
				const createdAt = message.createdAt.toISOString();
				const draft = {
					seq: message.seq,
					messageId: message.messageId,
					authorKind: message.authorKind,
					authorId: message.authorId,
					addressedToBotId: message.addressedToBotId,
					createdAt,
					...(message.origin === undefined ? {} : { origin: message.origin }),
				};
				const own = message.authorKind === "bot" && message.authorId === botId;
				const entry = own
					? await tx.appendEntry(AssistantEntry, ROOT_CONVERSATION_ID, {
							model: [migratedAssistantMessage({ ...draft, tenantId: message.tenantId, channelId: message.channelId, body: message.body })],
						})
					: await tx.appendEntry(ROOT_CONVERSATION_ID, attributedWriteEntryDraft({ ...draft, body: message.body }));
				log.lines.push({ ...draft, entryId: entry.id });
				written += 1;
			}
		}, BACKGROUND_CONTEXT);
	}
	return written;
}

/**
 * The record rows a bot's session should hold when it is built from the record: every message that stands, except the ones
 * still waiting in the bot's mailbox, which the turn takes in as it always did, so nothing is read twice.
 *
 * @param record Every row of the channel record, oldest first.
 * @param unreadSeqs The sequences of the bot's mailbox items.
 * @returns The rows to write.
 */
export const rowsForRebuild = (record: readonly ChannelMessageRecord[], unreadSeqs: ReadonlySet<number>): ChannelMessageRecord[] =>
	record.filter((message) => message.deletedAt === undefined && !unreadSeqs.has(message.seq));

/**
 * Build a bot's Pi session for a channel from the channel record, the way the migration built it from the old items.
 * Used by the spike's measurements; the turn owner builds a dropped session with {@link writeRecordMessages} itself.
 *
 * What the rebuilt session does not have is everything the record does not keep: the tool calls, tool results and
 * reasoning of past turns, compaction summaries, system prompt entries, per-call cost documents, usage totals, and the
 * provider session identity. The model sees the text of the channel and nothing else.
 *
 * @param deps Clients, table and bucket of the Pi sessions.
 * @param botId The bot whose session is built.
 * @param messages The record rows the session should hold, oldest first.
 * @returns How many messages were written.
 */
export async function rebuildSessionFromRecord(
	deps: OwnerStorageDependencies,
	botId: string,
	messages: readonly ChannelMessageRecord[],
): Promise<number> {
	if (messages.length === 0) return 0;
	const { tenantId, channelId } = messages[0]!;
	const owner = await openOwnerSession(storageIdFor(tenantId, botId, channelId), {
		...deps,
		models: createModels(),
		extensions: [],
		context: BACKGROUND_CONTEXT,
	});
	try {
		await owner.harness.root(BACKGROUND_CONTEXT);
		return await writeRecordMessages(owner.harness, botId, messages);
	} finally {
		await owner.close();
	}
}
