import { DeleteItemCommand, PutItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { list as listMailbox, removeAt as removeMailboxItemAt } from "../pi/mailbox.ts";
import { dropSession } from "../pi/session-drop.ts";
import { rebuildSessionFromRecord } from "../pi/session-rebuild.ts";
import { storageIdFor } from "../storage/storage-support.ts";
import { type Channel, ChannelNotFoundError, requireChannelTenant } from "./channels.ts";
import type { MessageDependencies } from "./messages.ts";

/** What one bot's session did when a message was erased. */
export type BotErasureOutcome = {
	botId: string;
	/** `rebuilt`: dropped and rebuilt from the record. `deferred`: a turn was open, so the session was left and a pending marker written. */
	outcome: "rebuilt" | "deferred";
	droppedItems: number;
	droppedObjectVersions: number;
	rebuiltMessages: number;
};

/** What erasing one message did. */
export type ErasureReport = {
	/** The sequences tombstoned: the message and the bot answers to the turn it started. */
	erasedSeqs: number[];
	bots: BotErasureOutcome[];
};

/** Which message to erase. */
export type EraseMessageRequest = { tenantId: string; channelId: string; seq: number };

const pendingPartition = (tenantId: string, channelId: string): string => `ERASURE#${tenantId}#${channelId}`;
const pendingSortKey = (seq: number): string => String(seq).padStart(10, "0");

/**
 * Erase one message: its text leaves every store the control plane controls, now, except the stores that expire (see
 * docs/MESSAGE_ERASURE.md).
 *
 * The record row and the row of every bot answer to the turn that message started become tombstones. The message's mailbox
 * items are deleted. Then, for each bot on the channel with no open turn, the bot's Pi session is deleted (DynamoDB items,
 * and every S3 object version) and rebuilt from the record, so it holds every remaining message and none of the erased
 * text. A bot with an open turn keeps its session until the turn ends: the work is written down as pending and finished by
 * {@link completePendingErasures}. Running this again for the same message repeats every step safely.
 *
 * Not built here, because no route may call this yet: the gate that stops a new turn from starting between the drop and
 * the rebuild, the removal of turn events (which expire after 24 hours), and the cleanup of departed bots' sessions.
 *
 * @param deps Message dependencies; `listing` carries the Pi session clients.
 * @param request The message.
 * @returns What was tombstoned and what happened to each bot's session.
 * @throws ChannelNotFoundError If the channel or the message does not exist.
 */
export async function eraseMessage(deps: MessageDependencies, request: EraseMessageRequest): Promise<ErasureReport> {
	const channel = await requireChannelTenant(request.channelId, request.tenantId, deps);
	const record = await deps.store.listMessages(channel.tenantId, channel.channelId, 0);
	if (!record.some((message) => message.seq === request.seq)) {
		throw new ChannelNotFoundError(`Channel ${channel.channelId} has no message ${request.seq}.`);
	}
	const erasedSeqs = record
		.filter((message) => message.seq === request.seq || message.inReplyToSeq === request.seq)
		.map((message) => message.seq);
	const now = deps.clock.now();
	for (const seq of erasedSeqs) {
		await deps.store.tombstoneMessage(channel.tenantId, channel.channelId, seq, now);
	}
	const botIds = channel.participants.filter((participant) => participant.kind === "bot").map((participant) => participant.actorId);
	for (const botId of botIds) {
		for (const seq of erasedSeqs) {
			await removeMailboxItemAt(deps.mailbox, channel.tenantId, botId, channel.channelId, seq);
		}
	}
	const bots: BotErasureOutcome[] = [];
	let pending = false;
	for (const botId of botIds) {
		const open = await deps.turns.openTurn(channel.tenantId, channel.channelId, botId);
		if (open !== null && open.active) {
			pending = true;
			bots.push({ botId, outcome: "deferred", droppedItems: 0, droppedObjectVersions: 0, rebuiltMessages: 0 });
			continue;
		}
		bots.push(await dropAndRebuild(deps, channel, botId));
	}
	if (pending) {
		await deps.mailbox.client.send(
			new PutItemCommand({
				TableName: deps.mailbox.tableName,
				Item: {
					pk: { S: pendingPartition(channel.tenantId, channel.channelId) },
					sk: { S: pendingSortKey(request.seq) },
					seq: { N: String(request.seq) },
					requested_at: { S: now.toISOString() },
				},
			}),
		);
	} else {
		await deps.mailbox.client.send(
			new DeleteItemCommand({
				TableName: deps.mailbox.tableName,
				Key: { pk: { S: pendingPartition(channel.tenantId, channel.channelId) }, sk: { S: pendingSortKey(request.seq) } },
			}),
		);
	}
	return { erasedSeqs, bots };
}

async function dropAndRebuild(deps: MessageDependencies, channel: Channel, botId: string): Promise<BotErasureOutcome> {
	const dropped = await dropSession(
		{
			client: deps.listing.client,
			s3: deps.listing.s3,
			conversationsTableName: deps.listing.conversationsTableName,
			bucket: deps.listing.bucket,
			commitCache: deps.listing.commitCache,
		},
		storageIdFor(channel.tenantId, botId, channel.channelId),
	);
	const unread = new Set((await listMailbox(deps.mailbox, channel.tenantId, botId, channel.channelId)).map((item) => item.seq));
	const keep = (await deps.store.listMessages(channel.tenantId, channel.channelId, 0)).filter(
		(message) => message.deletedAt === undefined && !unread.has(message.seq),
	);
	const rebuiltMessages = await rebuildSessionFromRecord(
		{
			client: deps.listing.client,
			s3: deps.listing.s3,
			tableName: deps.listing.conversationsTableName,
			bucket: deps.listing.bucket,
		},
		botId,
		keep,
	);
	return { botId, outcome: "rebuilt", droppedItems: dropped.items, droppedObjectVersions: dropped.objectVersions, rebuiltMessages };
}

/**
 * Finish the erasures that were deferred because a bot had a turn open: run each pending message again, which cascades to
 * any answer the finished turn committed meanwhile and drops and rebuilds the sessions that are idle now. A message whose
 * bots are all idle has its pending marker cleared by the run itself.
 *
 * @param deps Message dependencies.
 * @param tenantId Organization.
 * @param channelId Channel.
 * @returns The report of each pending erasure, oldest first.
 */
export async function completePendingErasures(deps: MessageDependencies, tenantId: string, channelId: string): Promise<ErasureReport[]> {
	const reports: ErasureReport[] = [];
	const page = await deps.mailbox.client.send(
		new QueryCommand({
			TableName: deps.mailbox.tableName,
			KeyConditionExpression: "pk = :pk",
			ExpressionAttributeValues: { ":pk": { S: pendingPartition(tenantId, channelId) } },
			ConsistentRead: true,
		}),
	);
	for (const item of page.Items ?? []) {
		reports.push(await eraseMessage(deps, { tenantId, channelId, seq: Number(item.seq!.N) }));
	}
	return reports;
}
