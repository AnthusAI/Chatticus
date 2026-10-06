import type { Context } from "@earendil-works/chord";
import { type Conversation, type Cursor, type EntryId, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { Channel } from "../domain/channels.ts";
import type { Turn } from "../domain/turns.ts";
import { recordTurnSpendOnce } from "../ledger/vendor-ledger.ts";
import { appendLine, ChannelLogDoc, readEntryBody } from "../pi/channel-log.ts";
import { allocateSeq, put as putMailboxItem, type MailboxStore } from "../pi/mailbox.ts";
import type { OwnerSession } from "../pi/session.ts";
import type { Bot } from "../store/codecs/bot.ts";
import { getTurn } from "../domain/turns.ts";
import type { ExecutorDeps } from "./types.ts";

const ENTRY_PAGE_SIZE = 200;

/** What finalizing needs to know about the running attempt. */
export type FinalizeInputs = {
	readonly deps: ExecutorDeps;
	readonly turn: Turn;
	readonly attemptId: string;
	readonly bot: Bot;
	readonly channel: Channel;
	readonly session: OwnerSession;
	readonly root: Conversation;
	readonly context: Context;
};

/** The channel message a completed turn commits. */
export type CommittedReply = { readonly messageSeq: number; readonly body: string };

/** The id of the log line of a turn's reply; stable, so a re-run of finalize finds the line it already wrote. */
export const replyMessageIdFor = (turnId: string): string => `reply-${turnId}`;

type UsageTotals = { inputTotal: number; outputTotal: number; vendor: string; model: string };

/**
 * Add up the model usage of a turn: every assistant message from the turn's prompt entry on, steered messages and tool
 * rounds included. Input counts cached tokens too, because the ledger has one input counter.
 *
 * @param root The root conversation.
 * @param promptEntryId The entry of the turn's prompt.
 * @param context Cancellation context.
 * @returns The totals and the vendor and model of the newest assistant message, or null when the model never answered.
 */
export async function measureTurnUsage(
	root: Conversation,
	promptEntryId: number,
	context: Context,
): Promise<UsageTotals | null> {
	let totals: UsageTotals | null = null;
	let cursor: Cursor | undefined;
	do {
		const page = await root.entries({ minEntryId: promptEntryId as EntryId }, ENTRY_PAGE_SIZE, cursor, context);
		for (const entry of page.items) {
			const message = entry.model?.[0];
			if (message?.role !== "assistant") continue;
			if (totals === null) totals = { inputTotal: 0, outputTotal: 0, vendor: message.provider, model: message.model };
			totals.inputTotal += message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
			totals.outputTotal += message.usage.output;
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return totals;
}

/**
 * Write the part of the turn's usage that the vendor ledger does not hold yet. The ledger row and the turn record's
 * recorded counters move in one transaction under the attempt's fence, so a recovered attempt never counts twice.
 *
 * @param inputs The running attempt.
 * @param promptEntryId The entry of the turn's prompt, or null when the prompt was never placed.
 */
export async function recordTurnSpend(inputs: FinalizeInputs, promptEntryId: number | null): Promise<void> {
	if (promptEntryId === null) return;
	const totals = await measureTurnUsage(inputs.root, promptEntryId, inputs.context);
	if (totals === null) return;
	const recorded = await getTurn(inputs.deps.turns, inputs.turn.tenantId, inputs.turn.turnId);
	await recordTurnSpendOnce(inputs.deps.ledger, {
		tenantId: inputs.turn.tenantId,
		turnId: inputs.turn.turnId,
		attemptId: inputs.attemptId,
		usage: { vendor: totals.vendor, model: totals.model },
		progress: {
			inputTotal: totals.inputTotal,
			outputTotal: totals.outputTotal,
			inputRecorded: recorded.ledgerInputRecorded,
			outputRecorded: recorded.ledgerOutputRecorded,
		},
	});
}

/**
 * Commit the turn's reply to the channel: only the final assistant text. The text already exists once, as the final
 * assistant entry of the Pi session; this allocates the next channel sequence, adds the channel log line that points
 * at that entry, and mirrors the reply into the mailbox of every other bot on the channel. It is idempotent: a re-run
 * after a crash finds the line it already wrote and reuses its sequence.
 *
 * @param inputs The running attempt.
 * @param answerEntryId The final assistant entry of the turn.
 * @returns The committed sequence and the text.
 */
export async function commitFinalAnswer(inputs: FinalizeInputs, answerEntryId: number): Promise<CommittedReply> {
	const { deps, turn, session, context } = inputs;
	const body = (await readEntryBody(session.storage, answerEntryId, context)) ?? "";
	const messageId = replyMessageIdFor(turn.turnId);
	const log = await session.harness.snapshot(ChannelLogDoc, ROOT_CONVERSATION_ID, context);
	const existing = log?.lines.find((line) => line.messageId === messageId);
	const mailbox: MailboxStore = { client: deps.client, tableName: deps.messagingTableName };
	const createdAt = existing?.createdAt ?? deps.turns.clock.now().toISOString();
	const messageSeq = existing?.seq ?? (await allocateSeq(mailbox, turn.tenantId, turn.channelId));
	await appendLine(
		session.harness,
		{
			seq: messageSeq,
			messageId,
			authorKind: "bot",
			authorId: turn.botId,
			addressedToBotId: null,
			createdAt,
			entryId: answerEntryId,
		},
		context,
	);
	for (const participant of inputs.channel.participants) {
		if (participant.kind !== "bot" || participant.actorId === turn.botId) continue;
		await putMailboxItem(mailbox, {
			tenantId: turn.tenantId,
			botId: participant.actorId,
			channelId: turn.channelId,
			seq: messageSeq,
			messageId,
			authorKind: "bot",
			authorId: turn.botId,
			addressedToBotId: null,
			body,
			createdAt,
		});
	}
	return { messageSeq, body };
}
