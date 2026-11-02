import {
	type AttributeValue,
	DeleteItemCommand,
	type DynamoDBClient,
	PutItemCommand,
	QueryCommand,
	type QueryCommandOutput,
	UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { list as listMailbox, removeAt as removeMailboxItemAt } from "../pi/mailbox.ts";
import { dropSession } from "../pi/session-drop.ts";
import { copySessionCallCosts } from "../ledger/call-cost-copy.ts";
import { storageIdFor } from "../storage/storage-support.ts";
import { computerActionKey } from "../store/keys.ts";
import { type Channel, ChannelNotFoundError, requireChannelTenant } from "./channels.ts";
import type { MessageDependencies } from "./messages.ts";

/** What erasing needs: the store, the clock, the mailbox table, the turn pointers to see whether a turn is open, and the Pi session clients. */
export type ErasureDependencies = Pick<MessageDependencies, "store" | "clock" | "mailbox" | "listing"> & {
	readonly turns: Pick<MessageDependencies["turns"], "openTurn">;
};

/** What one bot's session did when a message was erased. */
export type BotErasureOutcome = {
	botId: string;
	/** `dropped`: the session is gone and the turn owner rebuilds it from the record at the start of the bot's next turn. `deferred`: a turn was open, so the session was left and a pending marker written. */
	outcome: "dropped" | "deferred";
	droppedItems: number;
	droppedObjectVersions: number;
};

/** What erasing one message did. */
export type ErasureReport = {
	/** The sequences tombstoned: the message and the bot answers to the turn it started. */
	erasedSeqs: number[];
	bots: BotErasureOutcome[];
	/** Turns whose events and computer action arguments and results were swept, because an answer of theirs was erased. */
	sweptTurnIds: string[];
};

/** Which message to erase. */
export type EraseMessageRequest = { tenantId: string; channelId: string; seq: number };

/** The one partition that holds every pending erasure, so a sweep finds them all with one query. */
export const PENDING_ERASURE_PARTITION = "ERASURE#pending";
const pendingSortKey = (tenantId: string, channelId: string, seq: number): string => `${tenantId}#${channelId}#${String(seq).padStart(10, "0")}`;

/**
 * Erase one message: its text leaves every store the control plane controls, now, except the stores that expire (see
 * docs/MESSAGE_ERASURE.md).
 *
 * The record row and the row of every bot answer to the turn that message started become tombstones. The message's mailbox
 * items are deleted. Then, for each bot on the channel with no open turn, the bot's per-call cost records are copied out
 * and its Pi session is deleted (DynamoDB items, and every S3 object version); the turn owner rebuilds it from the record
 * at the start of the bot's next turn, so it holds every remaining message and none of the erased text. A bot with an open turn keeps its session until the turn ends: the work is written down as pending and finished by
 * {@link completePendingErasures}. Running this again for the same message repeats every step safely.
 *
 * The events and the computer action arguments and results of the turns whose answers were erased are swept too. Not built
 * here, because no route may call this yet: the cleanup of departed bots' sessions.
 *
 * @param deps Message dependencies; `listing` carries the Pi session clients.
 * @param request The message.
 * @returns What was tombstoned and what happened to each bot's session.
 * @throws ChannelNotFoundError If the channel or the message does not exist.
 */
export async function eraseMessage(deps: ErasureDependencies, request: EraseMessageRequest): Promise<ErasureReport> {
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
			bots.push({ botId, outcome: "deferred", droppedItems: 0, droppedObjectVersions: 0 });
			continue;
		}
		bots.push(await dropSessionOf(deps, channel, botId));
	}
	if (pending) {
		await deps.mailbox.client.send(
			new PutItemCommand({
				TableName: deps.mailbox.tableName,
				Item: {
					pk: { S: PENDING_ERASURE_PARTITION },
					sk: { S: pendingSortKey(channel.tenantId, channel.channelId, request.seq) },
					tenant_id: { S: channel.tenantId },
					channel_id: { S: channel.channelId },
					seq: { N: String(request.seq) },
					requested_at: { S: now.toISOString() },
				},
			}),
		);
	} else {
		await deps.mailbox.client.send(
			new DeleteItemCommand({
				TableName: deps.mailbox.tableName,
				Key: { pk: { S: PENDING_ERASURE_PARTITION }, sk: { S: pendingSortKey(channel.tenantId, channel.channelId, request.seq) } },
			}),
		);
	}
	const sweptTurnIds = record
		.filter((message) => erasedSeqs.includes(message.seq) && message.messageId.startsWith(REPLY_MESSAGE_ID_PREFIX))
		.map((message) => message.messageId.slice(REPLY_MESSAGE_ID_PREFIX.length));
	for (const turnId of sweptTurnIds) await sweepTurn(deps, channel.tenantId, turnId);
	return { erasedSeqs, bots, sweptTurnIds };
}

async function dropSessionOf(deps: ErasureDependencies, channel: Channel, botId: string): Promise<BotErasureOutcome> {
	await copySessionCallCosts(
		{
			client: deps.listing.client,
			s3: deps.listing.s3,
			messagingTableName: deps.listing.messagingTableName,
			conversationsTableName: deps.listing.conversationsTableName,
			bucket: deps.listing.bucket,
		},
		channel.tenantId,
		botId,
		channel.channelId,
	);
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
	return { botId, outcome: "dropped", droppedItems: dropped.items, droppedObjectVersions: dropped.objectVersions };
}

const REPLY_MESSAGE_ID_PREFIX = "reply-";

/**
 * Remove what a turn left outside the channel record: its events (streamed tokens, tool arguments and outputs, the
 * completed body) and the arguments and result of its computer actions. The action records stay, with their status and
 * ids, because they account for what ran.
 */
async function sweepTurn(deps: ErasureDependencies, tenantId: string, turnId: string): Promise<void> {
	const { client, tableName } = deps.mailbox;
	const partition = `${tenantId}#turn#${turnId}`;
	const list = async (prefix: string) =>
		(
			await client.send(
				new QueryCommand({
					TableName: tableName,
					KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
					ExpressionAttributeValues: { ":pk": { S: partition }, ":prefix": { S: prefix } },
					ConsistentRead: true,
				}),
			)
		).Items ?? [];
	for (const event of await list("evt#")) {
		await client.send(new DeleteItemCommand({ TableName: tableName, Key: { pk: event.pk!, sk: event.sk! } }));
	}
	for (const index of await list("act#")) {
		const actionId = index.action_id?.S;
		if (actionId === undefined) continue;
		const key = computerActionKey(tenantId, actionId);
		await client.send(
			new UpdateItemCommand({
				TableName: tableName,
				Key: { pk: { S: key.pk }, sk: { S: key.sk } },
				UpdateExpression: "SET arguments = :empty REMOVE #result",
				ConditionExpression: "attribute_exists(pk)",
				ExpressionAttributeNames: { "#result": "result" },
				ExpressionAttributeValues: { ":empty": { S: "{}" } },
			}),
		);
	}
}

/**
 * Whether any erasure of a channel is waiting for a turn to end. The turn executor asks this when a turn ends.
 *
 * @param store Messaging table client.
 * @param tenantId Organization.
 * @param channelId Channel.
 */
export async function hasPendingErasure(store: { client: DynamoDBClient; tableName: string }, tenantId: string, channelId: string): Promise<boolean> {
	const page = await store.client.send(
		new QueryCommand({
			TableName: store.tableName,
			KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
			ExpressionAttributeValues: { ":pk": { S: PENDING_ERASURE_PARTITION }, ":prefix": { S: `${tenantId}#${channelId}#` } },
			ConsistentRead: true,
			Limit: 1,
		}),
	);
	return (page.Items ?? []).length > 0;
}

/**
 * Finish the erasures that were deferred because a bot had a turn open: run each pending message again, which cascades to
 * any answer the finished turn committed meanwhile and drops the sessions that are idle now. A message whose bots are all
 * idle has its pending marker cleared by the run itself.
 *
 * @param deps Message dependencies.
 * @param scope Only this organization's, or only this channel's, pending erasures; absent means every one.
 * @returns The report of each pending erasure, oldest first.
 */
export async function completePendingErasures(
	deps: ErasureDependencies,
	scope: { tenantId?: string; channelId?: string } = {},
): Promise<ErasureReport[]> {
	const reports: ErasureReport[] = [];
	const prefix = scope.tenantId === undefined ? undefined : `${scope.tenantId}#${scope.channelId === undefined ? "" : `${scope.channelId}#`}`;
	let startKey: Record<string, AttributeValue> | undefined;
	do {
		const page: QueryCommandOutput = await deps.mailbox.client.send(
			new QueryCommand({
				TableName: deps.mailbox.tableName,
				KeyConditionExpression: prefix === undefined ? "pk = :pk" : "pk = :pk AND begins_with(sk, :prefix)",
				ExpressionAttributeValues: { ":pk": { S: PENDING_ERASURE_PARTITION }, ...(prefix === undefined ? {} : { ":prefix": { S: prefix } }) },
				ConsistentRead: true,
				ExclusiveStartKey: startKey,
			}),
		);
		for (const item of page.Items ?? []) {
			reports.push(await eraseMessage(deps, { tenantId: item.tenant_id!.S!, channelId: item.channel_id!.S!, seq: Number(item.seq!.N) }));
		}
		startKey = page.LastEvaluatedKey;
	} while (startKey !== undefined);
	return reports;
}
