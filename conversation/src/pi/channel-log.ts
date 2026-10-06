import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createSession,
	defineDoc,
	type EntryId,
	ROOT_CONVERSATION_ID,
	type Session,
	type Storage,
	UserEntry,
} from "@earendil-works/pi-durable";

/** One channel message as the session's log knows it: metadata and a pointer to the Pi entry that holds the body. */
export type ChannelLogLine = {
	seq: number;
	messageId: string;
	authorKind: string;
	authorId: string;
	addressedToBotId: string | null;
	createdAt: string;
	entryId: number;
};

export type ChannelLogValue = { lines: ChannelLogLine[] };

/** The `chatticus.channel-log` conversation document: scope conversation, history latest. */
export const ChannelLogDoc = defineDoc<ChannelLogValue>({
	kind: "chatticus.channel-log",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ lines: [] }),
});

export type ChannelMessageDraft = Omit<ChannelLogLine, "entryId"> & { body: string };

type Committer = Pick<Session, "commit">;

const draftLine = (draft: ChannelMessageDraft, entryId: number): ChannelLogLine => ({
	seq: draft.seq,
	messageId: draft.messageId,
	authorKind: draft.authorKind,
	authorId: draft.authorId,
	addressedToBotId: draft.addressedToBotId,
	createdAt: draft.createdAt,
	entryId,
});

/**
 * Append one line to the channel log of the root conversation. Idempotent by message id: a line already present is not
 * added again.
 *
 * @param session The owner's session (or its root conversation); the commit is fenced by its storage.
 * @param line The line to record.
 * @param context Cancellation context.
 * @returns Whether a line was added.
 */
export async function appendLine(
	session: Committer,
	line: ChannelLogLine,
	context: Context = BACKGROUND_CONTEXT,
): Promise<boolean> {
	return session.commit(async (tx) => {
		const log = await tx.doc(ChannelLogDoc, ROOT_CONVERSATION_ID);
		if (log.lines.some((existing) => existing.messageId === line.messageId)) return false;
		log.lines.push(line);
		return true;
	}, context);
}

/**
 * The `write` entry draft for a message that is not this bot's own input: a user-role entry, no model call. The model
 * text is attributed to its author; `data` carries the attribution and the plain body for listings.
 *
 * @param draft The message.
 * @returns A draft suitable for `submit({type: "write", entry})` or `tx.appendEntry`.
 */
export const attributedWriteEntryDraft = (draft: ChannelMessageDraft) => ({
	kind: UserEntry.kind,
	model: [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: `${draft.authorId}: ${draft.body}` }],
			timestamp: Date.parse(draft.createdAt),
		},
	],
	data: {
		messageId: draft.messageId,
		authorKind: draft.authorKind,
		authorId: draft.authorId,
		body: draft.body,
	},
});

/**
 * Commit an attributed user-role entry and its channel log line in ONE commit. Idempotent by message id.
 *
 * @param session The owner's session.
 * @param draft The message.
 * @param context Cancellation context.
 * @returns The entry id.
 */
export async function writeAttributedMessage(
	session: Committer,
	draft: ChannelMessageDraft,
	context: Context = BACKGROUND_CONTEXT,
): Promise<number> {
	return session.commit(async (tx) => {
		const log = await tx.doc(ChannelLogDoc, ROOT_CONVERSATION_ID);
		const existing = log.lines.find((line) => line.messageId === draft.messageId);
		if (existing) return existing.entryId;
		const entry = await tx.appendEntry(ROOT_CONVERSATION_ID, attributedWriteEntryDraft(draft));
		log.lines.push(draftLine(draft, entry.id));
		return entry.id;
	}, context);
}

/** How far an input submission's channel log line is: not placed yet, just added, or already there. */
export type InputLineState = "pending" | "added" | "present";

/**
 * After `submit({type: "input" | "write", requestId})` has committed its entry inside Pi, add the missing log line. Safe to run
 * any number of times: the line is added at most once, and nothing is added while the submission is still queued.
 *
 * @param session The owner's session.
 * @param draft The message that was submitted.
 * @param requestId The request id used for the submission.
 * @param context Cancellation context.
 * @returns `pending` while the submission has no entry yet, `added` when this call wrote the line, `present` when it
 * was already there.
 */
export async function recordInputLine(
	session: Committer,
	draft: Omit<ChannelMessageDraft, "body">,
	requestId: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<InputLineState> {
	return session.commit(async (tx): Promise<InputLineState> => {
		const submission = await tx.submissionByRequest(ROOT_CONVERSATION_ID, requestId);
		if (submission?.entry === undefined) return "pending";
		const log = await tx.doc(ChannelLogDoc, ROOT_CONVERSATION_ID);
		if (log.lines.some((existing) => existing.messageId === draft.messageId)) return "present";
		log.lines.push(draftLine({ ...draft, body: "" }, submission.entry));
		return "added";
	}, context);
}

/**
 * After `submit({type: "input" | "write", requestId})` has committed its entry inside Pi, add the missing log line. Safe to run
 * any number of times: the line is added at most once, and nothing is added while the submission is still queued.
 *
 * @param session The owner's session.
 * @param draft The message that was submitted.
 * @param requestId The request id used for the submission.
 * @param context Cancellation context.
 * @returns Whether a line was added.
 */
export async function reconcileInputLine(
	session: Committer,
	draft: Omit<ChannelMessageDraft, "body">,
	requestId: string,
	context: Context = BACKGROUND_CONTEXT,
): Promise<boolean> {
	return (await recordInputLine(session, draft, requestId, context)) === "added";
}

/**
 * Read the channel log without owning the session: a plain Session over the storage, no Harness, no fence claim.
 *
 * @param storage A storage opened without a fence (reads need no ownership).
 * @param context Cancellation context.
 * @returns The ordered lines, empty when the session has no log yet.
 */
export async function readLog(storage: Storage, context: Context = BACKGROUND_CONTEXT): Promise<ChannelLogLine[]> {
	const session = createSession(storage);
	const value = await session.snapshot(ChannelLogDoc, ROOT_CONVERSATION_ID, context);
	return value === undefined ? [] : value.lines.map((line) => ({ ...line }));
}

/**
 * Read the plain text of one entry without owning the session: attributed `data.body` when present, otherwise the
 * text of the entry's first model message.
 *
 * @param storage A storage opened without a fence.
 * @param entryId The entry id from a log line.
 * @param context Cancellation context.
 * @returns The body, or undefined when the entry does not exist.
 */
export async function readEntryBody(
	storage: Storage,
	entryId: number,
	context: Context = BACKGROUND_CONTEXT,
): Promise<string | undefined> {
	const found = await storage.entry(entryId as EntryId, context);
	if (found === undefined) return undefined;
	const data = found.entry.data;
	if (typeof data === "object" && data !== null && !Array.isArray(data) && typeof data.body === "string") return data.body;
	const message = found.entry.model?.[0];
	if (message === undefined) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}
