import { createHash } from "node:crypto";
import {
	type AttributeValue,
	type DynamoDBClient,
	GetItemCommand,
	QueryCommand,
	ScanCommand,
} from "@aws-sdk/client-dynamodb";
import type { Channel } from "../domain/channels.ts";
import { decodeChannel } from "../store/codecs/channel.ts";

/** One DynamoDB item in the low-level attribute shape. */
export type LegacyItem = Record<string, AttributeValue>;

/** Where the migration reads the old Python-written items from. */
export type LegacyStore = { readonly client: DynamoDBClient; readonly tableName: string };

/** Which part of the table a pass looks at; both fields absent means every tenant. */
export type MigrationScope = { readonly tenantId?: string; readonly channelId?: string };

/**
 * One old message item as the Python control plane wrote it. `createdAt` is kept as the stored string so a listing
 * after the migration shows exactly what was shown before.
 */
export type LegacyMessage = {
	tenantId: string;
	channelId: string;
	seq: number;
	messageId: string;
	authorKind: string;
	authorId: string;
	body: string;
	addressedToBotId: string | null;
	createdAt: string;
};

/** The Python turn item, the fields the migration needs. */
export type LegacyTurn = {
	tenantId: string;
	turnId: string;
	channelId: string;
	botId: string;
	status: string;
	promptMessageSeq: number | null;
	terminalReason: string | null;
	item: LegacyItem;
};

/** Sort key prefix of the old message items inside a channel partition. */
export const LEGACY_MESSAGE_SORT_PREFIX = "msg#";

/**
 * Partition key of a channel as the Python store writes it.
 *
 * @param tenantId Organization.
 * @param channelId Channel.
 * @returns `<tenant>#channel#<channel>`.
 */
export const channelPartitionKey = (tenantId: string, channelId: string): string => `${tenantId}#channel#${channelId}`;

/**
 * Partition key of a turn as the Python store writes it.
 *
 * @param tenantId Organization.
 * @param turnId Turn.
 * @returns `<tenant>#turn#<turn>`.
 */
export const turnPartitionKeyOf = (tenantId: string, turnId: string): string => `${tenantId}#turn#${turnId}`;

const CHANNEL_MARKER = "#channel#";
const TURN_MARKER = "#turn#";

async function scanAll(
	store: LegacyStore,
	filterExpression: string,
	names: Record<string, string>,
	values: Record<string, AttributeValue>,
): Promise<LegacyItem[]> {
	const items: LegacyItem[] = [];
	let startKey: Record<string, AttributeValue> | undefined;
	do {
		const page = await store.client.send(
			new ScanCommand({
				TableName: store.tableName,
				FilterExpression: filterExpression,
				ExpressionAttributeNames: names,
				ExpressionAttributeValues: values,
				ConsistentRead: true,
				ExclusiveStartKey: startKey,
			}),
		);
		items.push(...(page.Items ?? []));
		startKey = page.LastEvaluatedKey;
	} while (startKey !== undefined);
	return items;
}

/**
 * Every channel meta item in scope. The table has no index by channel, so this is a filtered scan, which is acceptable
 * for a one-time operator tool on a household-sized table.
 *
 * @param store Table.
 * @param scope Tenant and channel filter.
 * @returns Channels ordered by tenant and channel id.
 */
export async function listLegacyChannels(store: LegacyStore, scope: MigrationScope = {}): Promise<Channel[]> {
	const prefix = scope.tenantId === undefined ? null : `${scope.tenantId}${CHANNEL_MARKER}`;
	const items =
		prefix === null
			? await scanAll(store, "#sk = :meta AND contains(#pk, :marker)", { "#sk": "sk", "#pk": "pk" }, {
					":meta": { S: "meta" },
					":marker": { S: CHANNEL_MARKER },
				})
			: await scanAll(store, "#sk = :meta AND begins_with(#pk, :prefix)", { "#sk": "sk", "#pk": "pk" }, {
					":meta": { S: "meta" },
					":prefix": { S: prefix },
				});
	const channels = items.map(decodeChannel).filter((channel) => scope.channelId === undefined || channel.channelId === scope.channelId);
	return channels.sort((left, right) =>
		`${left.tenantId}\u0000${left.channelId}`.localeCompare(`${right.tenantId}\u0000${right.channelId}`),
	);
}

const legacyMessageFrom = (item: LegacyItem): LegacyMessage => ({
	tenantId: item.tenant_id!.S!,
	channelId: item.channel_id!.S!,
	seq: Number(item.seq!.N),
	messageId: item.message_id!.S!,
	authorKind: item.author_kind!.S!,
	authorId: item.author_id!.S!,
	body: item.body?.S ?? "",
	addressedToBotId: item.addressed_to_bot_id?.S || null,
	createdAt: item.created_at!.S!,
});

/**
 * The old message items of a channel in sequence order.
 *
 * @param store Table.
 * @param tenantId Organization.
 * @param channelId Channel.
 * @param afterSeq Only messages with a greater sequence.
 * @returns The messages, oldest first.
 */
export async function listLegacyMessages(
	store: LegacyStore,
	tenantId: string,
	channelId: string,
	afterSeq = 0,
): Promise<LegacyMessage[]> {
	const messages: LegacyMessage[] = [];
	let startKey: Record<string, AttributeValue> | undefined;
	do {
		const page = await store.client.send(
			new QueryCommand({
				TableName: store.tableName,
				KeyConditionExpression: "pk = :pk AND sk > :after",
				ExpressionAttributeValues: {
					":pk": { S: channelPartitionKey(tenantId, channelId) },
					":after": { S: `${LEGACY_MESSAGE_SORT_PREFIX}${String(afterSeq).padStart(10, "0")}` },
				},
				ConsistentRead: true,
				ExclusiveStartKey: startKey,
			}),
		);
		for (const item of page.Items ?? []) {
			if (item.sk!.S!.startsWith(LEGACY_MESSAGE_SORT_PREFIX)) messages.push(legacyMessageFrom(item));
		}
		startKey = page.LastEvaluatedKey;
	} while (startKey !== undefined);
	return messages.sort((left, right) => left.seq - right.seq);
}

const legacyTurnFrom = (item: LegacyItem): LegacyTurn => ({
	tenantId: item.tenant_id!.S!,
	turnId: item.turn_id!.S!,
	channelId: item.channel_id!.S!,
	botId: item.bot_id!.S!,
	status: item.status!.S!,
	promptMessageSeq: item.prompt_message_seq?.N === undefined ? null : Number(item.prompt_message_seq.N),
	terminalReason: item.terminal_reason?.S || null,
	item,
});

/**
 * Every turn control item in scope (Python shape and already migrated alike; both share the `meta` item).
 *
 * @param store Table.
 * @param scope Tenant and channel filter.
 * @returns The turns, in no particular order.
 */
export async function listLegacyTurns(store: LegacyStore, scope: MigrationScope = {}): Promise<LegacyTurn[]> {
	const items =
		scope.tenantId === undefined
			? await scanAll(store, "#sk = :meta AND contains(#pk, :marker)", { "#sk": "sk", "#pk": "pk" }, {
					":meta": { S: "meta" },
					":marker": { S: TURN_MARKER },
				})
			: await scanAll(store, "#sk = :meta AND begins_with(#pk, :prefix)", { "#sk": "sk", "#pk": "pk" }, {
					":meta": { S: "meta" },
					":prefix": { S: `${scope.tenantId}${TURN_MARKER}` },
				});
	return items
		.map(legacyTurnFrom)
		.filter((turn) => scope.channelId === undefined || turn.channelId === scope.channelId);
}

/**
 * The turn a channel pointer item names.
 *
 * @param store Table.
 * @param tenantId Organization.
 * @param channelId Channel.
 * @param pointerSortKey Sort key of the pointer item, such as `latest_turn`.
 * @returns The turn id, or null when the pointer does not exist.
 */
export async function readPointerTurnId(
	store: LegacyStore,
	tenantId: string,
	channelId: string,
	pointerSortKey: string,
): Promise<string | null> {
	const result = await store.client.send(
		new GetItemCommand({
			TableName: store.tableName,
			Key: { pk: { S: channelPartitionKey(tenantId, channelId) }, sk: { S: pointerSortKey } },
			ConsistentRead: true,
		}),
	);
	return result.Item?.turn_id?.S ?? null;
}

/**
 * Digest of one message as the migration compares it: everything the listing shows.
 *
 * @param message The message fields.
 * @returns A hex digest.
 */
export function messageDigest(message: {
	seq: number;
	messageId: string;
	authorKind: string;
	authorId: string;
	body: string;
	addressedToBotId: string | null;
	createdAt: string;
}): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				message.seq,
				message.messageId,
				message.authorKind,
				message.authorId,
				message.addressedToBotId ?? "",
				message.createdAt,
				createHash("sha256").update(message.body).digest("hex"),
			]),
		)
		.digest("hex");
}

/**
 * One checksum over an ordered list of messages.
 *
 * @param messages The messages in sequence order.
 * @returns A hex digest that changes when any message, its order, or the count changes.
 */
export const transcriptChecksum = (messages: ReadonlyArray<Parameters<typeof messageDigest>[0]>): string =>
	createHash("sha256")
		.update(messages.map(messageDigest).join("\n"))
		.digest("hex");
