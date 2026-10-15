import {
	type AttributeValue,
	ConditionalCheckFailedException,
	DeleteItemCommand,
	type DynamoDBClient,
	PutItemCommand,
	QueryCommand,
	UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";

export type MailboxItem = {
	tenantId: string;
	botId: string;
	channelId: string;
	seq: number;
	messageId: string;
	authorKind: string;
	authorId: string;
	addressedToBotId: string | null;
	body: string;
	createdAt: string;
};

export type MailboxStore = { client: DynamoDBClient; tableName: string };

/**
 * Partition key of one bot session's mailbox.
 *
 * @param tenantId Organization.
 * @param botId Bot.
 * @param channelId Channel.
 * @returns `MB#<tenant>#<bot>#<channel>`.
 */
export const mailboxPartitionKey = (tenantId: string, botId: string, channelId: string): string =>
	`MB#${tenantId}#${botId}#${channelId}`;

/**
 * Sort key of a mailbox item.
 *
 * @param seq Channel message sequence.
 * @returns The sequence zero padded to ten digits.
 */
export const mailboxSortKey = (seq: number): string => String(seq).padStart(10, "0");

/**
 * Atomically allocate the next message sequence of a channel with one `UpdateItem` on its meta item. `next_seq` is the
 * next number to hand out, starting at 1, exactly as the Python control plane keeps it.
 *
 * @param store Table.
 * @param tenantId Organization.
 * @param channelId Channel.
 * @returns The allocated sequence number.
 */
export async function allocateSeq(store: MailboxStore, tenantId: string, channelId: string): Promise<number> {
	const result = await store.client.send(
		new UpdateItemCommand({
			TableName: store.tableName,
			Key: { pk: { S: `${tenantId}#channel#${channelId}` }, sk: { S: "meta" } },
			UpdateExpression: "SET next_seq = if_not_exists(next_seq, :one) + :one",
			ExpressionAttributeValues: { ":one": { N: "1" } },
			ReturnValues: "UPDATED_NEW",
		}),
	);
	const updated = result.Attributes?.next_seq?.N;
	if (updated === undefined) throw new Error(`seq allocation returned no value for channel ${channelId}`);
	return Number(updated) - 1;
}

/**
 * The DynamoDB item of one mailbox entry.
 *
 * @param item The message.
 * @returns The attributes, keyed by the bot session's mailbox partition and the zero padded sequence.
 */
export const mailboxItemAttributes = (item: MailboxItem): Record<string, AttributeValue> => ({
	pk: { S: mailboxPartitionKey(item.tenantId, item.botId, item.channelId) },
	sk: { S: mailboxSortKey(item.seq) },
	tenant_id: { S: item.tenantId },
	bot_id: { S: item.botId },
	channel_id: { S: item.channelId },
	seq: { N: String(item.seq) },
	message_id: { S: item.messageId },
	author_kind: { S: item.authorKind },
	author_id: { S: item.authorId },
	addressed_to_bot_id: { S: item.addressedToBotId ?? "" },
	body: { S: item.body },
	created_at: { S: item.createdAt },
});

/** The condition that makes a mailbox put idempotent: the slot is free or already holds this very message. */
export const MAILBOX_PUT_CONDITION = "attribute_not_exists(sk) OR message_id = :messageId";

/**
 * Put one inbound message into a bot session's mailbox. Idempotent for the same message at the same sequence.
 *
 * @param store Table.
 * @param item The message.
 * @throws Error when a different message already holds that sequence.
 */
export async function put(store: MailboxStore, item: MailboxItem): Promise<void> {
	try {
		await store.client.send(
			new PutItemCommand({
				TableName: store.tableName,
				Item: mailboxItemAttributes(item),
				ConditionExpression: MAILBOX_PUT_CONDITION,
				ExpressionAttributeValues: { ":messageId": { S: item.messageId } },
			}),
		);
	} catch (error) {
		if (error instanceof ConditionalCheckFailedException) {
			throw new Error(`mailbox seq ${item.seq} already holds a different message`, { cause: error });
		}
		throw error;
	}
}

/**
 * List a mailbox in sequence order.
 *
 * @param store Table.
 * @param tenantId Organization.
 * @param botId Bot.
 * @param channelId Channel.
 * @param afterSeq Only items with a greater sequence.
 * @returns The items, oldest first.
 */
export async function list(
	store: MailboxStore,
	tenantId: string,
	botId: string,
	channelId: string,
	afterSeq = 0,
): Promise<MailboxItem[]> {
	const items: MailboxItem[] = [];
	let startKey: Record<string, AttributeValue> | undefined;
	do {
		const page = await store.client.send(
			new QueryCommand({
				TableName: store.tableName,
				KeyConditionExpression: "pk = :pk AND sk > :after",
				ExpressionAttributeValues: {
					":pk": { S: mailboxPartitionKey(tenantId, botId, channelId) },
					":after": { S: mailboxSortKey(afterSeq) },
				},
				ConsistentRead: true,
				ExclusiveStartKey: startKey,
			}),
		);
		for (const raw of page.Items ?? []) {
			const addressed = raw.addressed_to_bot_id?.S ?? "";
			items.push({
				tenantId,
				botId,
				channelId,
				seq: Number(raw.seq?.N),
				messageId: raw.message_id?.S ?? "",
				authorKind: raw.author_kind?.S ?? "",
				authorId: raw.author_id?.S ?? "",
				addressedToBotId: addressed === "" ? null : addressed,
				body: raw.body?.S ?? "",
				createdAt: raw.created_at?.S ?? "",
			});
		}
		startKey = page.LastEvaluatedKey;
	} while (startKey !== undefined);
	return items;
}

/**
 * Delete one mailbox item. Deleting an item that is already gone is not an error.
 *
 * @param store Table.
 * @param item The item, which names its mailbox partition and sequence.
 */
export async function remove(store: MailboxStore, item: MailboxItem): Promise<void> {
	await store.client.send(
		new DeleteItemCommand({
			TableName: store.tableName,
			Key: { pk: { S: mailboxPartitionKey(item.tenantId, item.botId, item.channelId) }, sk: { S: mailboxSortKey(item.seq) } },
		}),
	);
}

/**
 * Hand every item to the handler in sequence order, deleting each one only after its handler resolved. A throwing
 * handler stops the drain and leaves that item and every later one in place.
 *
 * @param store Table.
 * @param tenantId Organization.
 * @param botId Bot.
 * @param channelId Channel.
 * @param handler Called once per item.
 * @returns How many items were drained.
 */
export async function drain(
	store: MailboxStore,
	tenantId: string,
	botId: string,
	channelId: string,
	handler: (item: MailboxItem) => Promise<void>,
): Promise<number> {
	let drained = 0;
	for (const item of await list(store, tenantId, botId, channelId)) {
		await handler(item);
		await remove(store, item);
		drained += 1;
	}
	return drained;
}
