import type { Context } from "@earendil-works/chord";
import { type Conversation, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { recordReplyDelivery, replyOriginOf } from "../channels/delivery.ts";
import type { Channel } from "../domain/channels.ts";
import type { Turn } from "../domain/turns.ts";
import { deriveCostRecords, readCallCostRecords } from "../ledger/call-cost.ts";
import { projectTurnCost, summarizeTurnCost, type TurnCostStatus } from "../ledger/turn-cost.ts";
import { appendLine, ChannelLogDoc, readEntryBody } from "../pi/channel-log.ts";
import { allocateSeq, put as putMailboxItem, type MailboxStore } from "../pi/mailbox.ts";
import type { OwnerSession } from "../pi/session.ts";
import type { Bot } from "../store/codecs/bot.ts";
import type { ExecutorDeps } from "./types.ts";

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

/** Where in the life of a turn its cost is being recorded; it becomes the status of the turn index item. */
export type CostRecordingPoint = "resumed" | "yielded" | "parked" | "completed" | "failed";

const statusOfPoint = (point: CostRecordingPoint): TurnCostStatus => (point === "resumed" ? "running" : point);

/** The request id under which a turn's prompt is submitted to the session; the submission names the prompt entry. */
export const promptRequestIdFor = (turnId: string): string => `turn:${turnId}`;

/**
 * Record the cost of the turn so far, from the session. This is the only path from model calls to dollars: the cost
 * records are derived from the assistant entries of the root conversation, keyed by entry (successful, errored and aborted
 * responses alike), plus the compaction spend the session's usage ledger holds beyond its entries, so doing it again, on
 * this owner or a later one, after a retry, a takeover or a crash, writes each call once and loses none the session
 * committed. Then the turn's ledger row and turn index item are written from those same records.
 *
 * @param inputs The running attempt.
 * @param point Where in the turn's life this is called.
 * @param messageSeq The sequence of the reply, when the turn has just committed one.
 */
export async function recordTurnCost(inputs: FinalizeInputs, point: CostRecordingPoint, messageSeq: number | null = null): Promise<void> {
	const { deps, turn, session, root, context } = inputs;
	const prompt = await session.harness.commit((tx) => tx.submissionByRequest(root.id, promptRequestIdFor(turn.turnId)), context);
	const promptEntryId = prompt?.entry;
	if (promptEntryId === undefined) return;
	await deriveCostRecords(
		session.harness,
		session.storage,
		{ conversationId: root.id, turnId: turn.turnId, promptEntryId: Number(promptEntryId), prices: deps.ledger.prices, now: deps.ledger.now },
		context,
	);
	const records = (await readCallCostRecords(session.harness, session.storage, root.id, context)).filter(
		(record) => record.turnId === turn.turnId,
	);
	const summary = summarizeTurnCost(records);
	if (summary === null) return;
	await projectTurnCost(
		deps.ledger,
		{
			tenantId: turn.tenantId,
			turnId: turn.turnId,
			kind: "turn",
			botId: turn.botId,
			channelId: turn.channelId,
			promptAuthorId: turn.promptAuthorId,
			promptMessageSeq: turn.promptMessageSeq,
			messageSeq: messageSeq ?? turn.messageSeq,
			ownerKind: deps.ownerKind,
			status: statusOfPoint(point),
		},
		summary,
	);
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
	if (deps.channelDelivery !== undefined) {
		const origin = replyOriginOf(log?.lines ?? [], turn, messageSeq);
		if (origin !== null) {
			await recordReplyDelivery(deps.channelDelivery, { tenantId: turn.tenantId, channelId: turn.channelId, messageId, messageSeq }, origin);
		}
	}
	return { messageSeq, body };
}
