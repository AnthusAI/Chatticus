import {
	type AttributeValue,
	ConditionalCheckFailedException,
	type DynamoDBClient,
	DeleteItemCommand,
	GetItemCommand,
	PutItemCommand,
	QueryCommand,
	TransactionCanceledException,
	TransactWriteItemsCommand,
	UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import type {
	ChannelBinding,
	ChannelSettings,
	ChannelStore,
	DeliveryRecord,
	DeliveryState,
	ExternalIdentityLink,
	InboundClaim,
	InboundMessageRecord,
	RouteTarget,
} from "../channels/records.ts";
import type { DeliveryFailureClass, TransportProvider } from "../channels/transport.ts";
import { retryTransient } from "./transient-retry.ts";

type Item = Record<string, AttributeValue>;

const channelsPartition = (tenantId: string): string => `${tenantId}#channels`;
const deliveriesPartition = (tenantId: string): string => `${tenantId}#channels#deliveries`;
const routePartition = (provider: string, routeKey: string): string => `route#${provider}#${routeKey}`;
const mailHandlePartition = (handle: string): string => `mailhandle#${handle}`;
const providerMessagePartition = (provider: string, providerMessageId: string): string => `dmsg#${provider}#${providerMessageId}`;
const deliverySortKey = (messageId: string, bindingId: string): string => `delivery#${messageId}#${bindingId}`;
const openSortKey = (delivery: DeliveryRecord): string =>
	`open#${delivery.createdAt.toISOString()}#${delivery.messageId}#${delivery.bindingId}`;

/** The route key as stored: addresses and other keys compare case-insensitively. */
export const normalizedRouteKey = (routeKey: string): string => routeKey.trim().toLowerCase();

const OPEN_STATES: readonly DeliveryState[] = ["pending", "retryable"];

function required(item: Item, name: string): string {
	const value = item[name]?.S;
	if (value === undefined) throw new Error(`malformed channel item: ${name}`);
	return value;
}

function encodeBinding(binding: ChannelBinding): Item {
	return {
		pk: { S: channelsPartition(binding.tenantId) },
		sk: { S: `binding#${binding.bindingId}` },
		tenant_id: { S: binding.tenantId },
		binding_id: { S: binding.bindingId },
		provider: { S: binding.provider },
		route_key: { S: binding.routeKey },
		bot_id: { S: binding.botId },
		enabled: { BOOL: binding.enabled },
		limits: { S: JSON.stringify(binding.limits) },
		created_by: { S: binding.createdBy },
		created_at: { S: binding.createdAt.toISOString() },
		updated_at: { S: binding.updatedAt.toISOString() },
	};
}

function decodeBinding(item: Item): ChannelBinding {
	return {
		tenantId: required(item, "tenant_id"),
		bindingId: required(item, "binding_id"),
		provider: required(item, "provider") as TransportProvider,
		routeKey: required(item, "route_key"),
		botId: required(item, "bot_id"),
		enabled: item.enabled?.BOOL ?? false,
		limits: JSON.parse(item.limits?.S ?? "{}") as Record<string, number>,
		createdBy: required(item, "created_by"),
		createdAt: new Date(required(item, "created_at")),
		updatedAt: new Date(required(item, "updated_at")),
	};
}

function encodeDelivery(delivery: DeliveryRecord): Item {
	const item: Item = {
		pk: { S: deliveriesPartition(delivery.tenantId) },
		sk: { S: deliverySortKey(delivery.messageId, delivery.bindingId) },
		tenant_id: { S: delivery.tenantId },
		message_id: { S: delivery.messageId },
		binding_id: { S: delivery.bindingId },
		channel_id: { S: delivery.channelId },
		message_seq: { N: String(delivery.messageSeq) },
		conversation_key: { S: delivery.conversationKey },
		recipient_external_id: { S: delivery.recipientExternalId },
		in_reply_to_external_message_id: { S: delivery.inReplyToExternalMessageId },
		state: { S: delivery.state },
		attempts: { N: String(delivery.attempts) },
		created_at: { S: delivery.createdAt.toISOString() },
		updated_at: { S: delivery.updatedAt.toISOString() },
	};
	if (delivery.failureClass !== null) item.failure_class = { S: delivery.failureClass };
	if (delivery.reasonCode !== null) item.reason_code = { S: delivery.reasonCode };
	if (delivery.providerMessageId !== null) item.provider_message_id = { S: delivery.providerMessageId };
	return item;
}

function decodeDelivery(item: Item): DeliveryRecord {
	return {
		tenantId: required(item, "tenant_id"),
		messageId: required(item, "message_id"),
		bindingId: required(item, "binding_id"),
		channelId: required(item, "channel_id"),
		messageSeq: Number(item.message_seq?.N),
		conversationKey: required(item, "conversation_key"),
		recipientExternalId: required(item, "recipient_external_id"),
		inReplyToExternalMessageId: required(item, "in_reply_to_external_message_id"),
		state: required(item, "state") as DeliveryState,
		attempts: Number(item.attempts?.N ?? "0"),
		failureClass: (item.failure_class?.S as DeliveryFailureClass | undefined) ?? null,
		reasonCode: item.reason_code?.S ?? null,
		providerMessageId: item.provider_message_id?.S ?? null,
		createdAt: new Date(required(item, "created_at")),
		updatedAt: new Date(required(item, "updated_at")),
	};
}

function decodeInboundRecord(item: Item): InboundMessageRecord {
	return {
		status: required(item, "status") as "claimed" | "done",
		claimedAt: new Date(required(item, "claimed_at")),
		channelId: item.channel_id?.S ?? null,
		messageId: item.message_id?.S ?? null,
		turnId: item.turn_id?.S ?? null,
	};
}

/** The Messaging table implementation of ChannelStore. */
export class DynamoChannelStore implements ChannelStore {
	private readonly client: DynamoDBClient;
	private readonly tableName: string;

	/**
	 * @param client DynamoDB client.
	 * @param tableName The Messaging table.
	 */
	constructor(client: DynamoDBClient, tableName: string) {
		this.client = client;
		this.tableName = tableName;
	}

	private async get(pk: string, sk: string): Promise<Item | null> {
		const response = await this.client.send(
			new GetItemCommand({ TableName: this.tableName, Key: { pk: { S: pk }, sk: { S: sk } }, ConsistentRead: true }),
		);
		return response.Item ?? null;
	}

	private async query(pk: string, prefix: string): Promise<Item[]> {
		const items: Item[] = [];
		let exclusiveStartKey: Item | undefined;
		do {
			const response = await this.client.send(
				new QueryCommand({
					TableName: this.tableName,
					KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
					ExpressionAttributeValues: { ":pk": { S: pk }, ":prefix": { S: prefix } },
					ConsistentRead: true,
					ExclusiveStartKey: exclusiveStartKey,
				}),
			);
			items.push(...(response.Items ?? []));
			exclusiveStartKey = response.LastEvaluatedKey;
		} while (exclusiveStartKey !== undefined);
		return items;
	}

	async getSettings(tenantId: string): Promise<ChannelSettings> {
		const item = await this.get(channelsPartition(tenantId), "settings");
		return {
			tenantId,
			externalChannelsEnabled: item?.external_channels_enabled?.BOOL ?? false,
			mailHandle: item?.mail_handle?.S ?? null,
		};
	}

	async setExternalChannelsEnabled(tenantId: string, enabled: boolean): Promise<void> {
		await this.client.send(
			new UpdateItemCommand({
				TableName: this.tableName,
				Key: { pk: { S: channelsPartition(tenantId) }, sk: { S: "settings" } },
				UpdateExpression: "SET external_channels_enabled = :enabled, tenant_id = :tenant",
				ExpressionAttributeValues: { ":enabled": { BOOL: enabled }, ":tenant": { S: tenantId } },
			}),
		);
	}

	async claimMailHandle(tenantId: string, handle: string): Promise<boolean> {
		const previous = (await this.getSettings(tenantId)).mailHandle;
		try {
			await this.client.send(
				new TransactWriteItemsCommand({
					TransactItems: [
						{
							Put: {
								TableName: this.tableName,
								Item: { pk: { S: mailHandlePartition(handle) }, sk: { S: "claim" }, tenant_id: { S: tenantId } },
								ConditionExpression: "attribute_not_exists(pk) OR tenant_id = :tenant",
								ExpressionAttributeValues: { ":tenant": { S: tenantId } },
							},
						},
						{
							Update: {
								TableName: this.tableName,
								Key: { pk: { S: channelsPartition(tenantId) }, sk: { S: "settings" } },
								UpdateExpression: "SET mail_handle = :handle, tenant_id = :tenant",
								ExpressionAttributeValues: { ":handle": { S: handle }, ":tenant": { S: tenantId } },
							},
						},
					],
				}),
			);
		} catch (error) {
			if (error instanceof TransactionCanceledException) return false;
			throw error;
		}
		if (previous !== null && previous !== handle) {
			await this.client.send(
				new DeleteItemCommand({ TableName: this.tableName, Key: { pk: { S: mailHandlePartition(previous) }, sk: { S: "claim" } } }),
			);
		}
		return true;
	}

	async createBinding(binding: ChannelBinding): Promise<boolean> {
		try {
			await this.client.send(
				new TransactWriteItemsCommand({
					TransactItems: [
						{
							Put: {
								TableName: this.tableName,
								Item: {
									pk: { S: routePartition(binding.provider, binding.routeKey) },
									sk: { S: "route" },
									tenant_id: { S: binding.tenantId },
									binding_id: { S: binding.bindingId },
								},
								ConditionExpression: "attribute_not_exists(pk)",
							},
						},
						{ Put: { TableName: this.tableName, Item: encodeBinding(binding), ConditionExpression: "attribute_not_exists(pk)" } },
					],
				}),
			);
			return true;
		} catch (error) {
			if (error instanceof TransactionCanceledException) return false;
			throw error;
		}
	}

	async getBinding(tenantId: string, bindingId: string): Promise<ChannelBinding | null> {
		const item = await this.get(channelsPartition(tenantId), `binding#${bindingId}`);
		return item === null ? null : decodeBinding(item);
	}

	async listBindings(tenantId: string): Promise<ChannelBinding[]> {
		const items = await this.query(channelsPartition(tenantId), "binding#");
		return items.map(decodeBinding).sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.bindingId.localeCompare(right.bindingId));
	}

	async setBindingEnabled(tenantId: string, bindingId: string, enabled: boolean, at: Date): Promise<ChannelBinding | null> {
		try {
			const response = await this.client.send(
				new UpdateItemCommand({
					TableName: this.tableName,
					Key: { pk: { S: channelsPartition(tenantId) }, sk: { S: `binding#${bindingId}` } },
					UpdateExpression: "SET enabled = :enabled, updated_at = :at",
					ConditionExpression: "attribute_exists(pk)",
					ExpressionAttributeValues: { ":enabled": { BOOL: enabled }, ":at": { S: at.toISOString() } },
					ReturnValues: "ALL_NEW",
				}),
			);
			return response.Attributes === undefined ? null : decodeBinding(response.Attributes);
		} catch (error) {
			if (error instanceof ConditionalCheckFailedException) return null;
			throw error;
		}
	}

	async resolveRoute(provider: TransportProvider, routeKey: string): Promise<RouteTarget | null> {
		const item = await this.get(routePartition(provider, routeKey), "route");
		return item === null ? null : { tenantId: required(item, "tenant_id"), bindingId: required(item, "binding_id") };
	}

	async getIdentityLink(tenantId: string, provider: TransportProvider, externalId: string): Promise<ExternalIdentityLink | null> {
		const item = await this.get(channelsPartition(tenantId), `identity#${provider}#${externalId}`);
		if (item === null) return null;
		return {
			tenantId,
			provider,
			externalId,
			userId: required(item, "user_id"),
			linkedBy: required(item, "linked_by"),
			linkedAt: new Date(required(item, "linked_at")),
		};
	}

	async putIdentityLink(link: ExternalIdentityLink): Promise<void> {
		await this.client.send(
			new PutItemCommand({
				TableName: this.tableName,
				Item: {
					pk: { S: channelsPartition(link.tenantId) },
					sk: { S: `identity#${link.provider}#${link.externalId}` },
					tenant_id: { S: link.tenantId },
					user_id: { S: link.userId },
					linked_by: { S: link.linkedBy },
					linked_at: { S: link.linkedAt.toISOString() },
				},
			}),
		);
	}

	async getConversationChannel(tenantId: string, bindingId: string, conversationKey: string): Promise<string | null> {
		const item = await this.get(channelsPartition(tenantId), `conv#${bindingId}#${conversationKey}`);
		return item?.channel_id?.S ?? null;
	}

	async putConversationChannelIfAbsent(tenantId: string, bindingId: string, conversationKey: string, channelId: string): Promise<string> {
		return this.putIndexIfAbsent(tenantId, `conv#${bindingId}#${conversationKey}`, channelId);
	}

	async getMessageChannel(tenantId: string, bindingId: string, externalMessageId: string): Promise<string | null> {
		const item = await this.get(channelsPartition(tenantId), `emsg#${bindingId}#${externalMessageId}`);
		return item?.channel_id?.S ?? null;
	}

	async putMessageChannel(tenantId: string, bindingId: string, externalMessageId: string, channelId: string): Promise<void> {
		await this.putIndexIfAbsent(tenantId, `emsg#${bindingId}#${externalMessageId}`, channelId);
	}

	private async putIndexIfAbsent(tenantId: string, sortKey: string, channelId: string): Promise<string> {
		try {
			await this.client.send(
				new PutItemCommand({
					TableName: this.tableName,
					Item: { pk: { S: channelsPartition(tenantId) }, sk: { S: sortKey }, tenant_id: { S: tenantId }, channel_id: { S: channelId } },
					ConditionExpression: "attribute_not_exists(pk)",
				}),
			);
			return channelId;
		} catch (error) {
			if (!(error instanceof ConditionalCheckFailedException)) throw error;
			const existing = await this.get(channelsPartition(tenantId), sortKey);
			return existing?.channel_id?.S ?? channelId;
		}
	}

	async claimInbound(tenantId: string, bindingId: string, externalMessageId: string, now: Date, leaseSeconds: number): Promise<InboundClaim> {
		const sortKey = `inbound#${bindingId}#${externalMessageId}`;
		try {
			await this.client.send(
				new PutItemCommand({
					TableName: this.tableName,
					Item: {
						pk: { S: channelsPartition(tenantId) },
						sk: { S: sortKey },
						tenant_id: { S: tenantId },
						status: { S: "claimed" },
						claimed_at: { S: now.toISOString() },
					},
					ConditionExpression: "attribute_not_exists(pk)",
				}),
			);
			return { kind: "claimed" };
		} catch (error) {
			if (!(error instanceof ConditionalCheckFailedException)) throw error;
		}
		const item = await this.get(channelsPartition(tenantId), sortKey);
		if (item === null) return this.claimInbound(tenantId, bindingId, externalMessageId, now, leaseSeconds);
		const record = decodeInboundRecord(item);
		if (record.status === "done") return { kind: "done", record };
		if (record.claimedAt.getTime() + leaseSeconds * 1000 > now.getTime()) return { kind: "in_flight" };
		try {
			await this.client.send(
				new UpdateItemCommand({
					TableName: this.tableName,
					Key: { pk: { S: channelsPartition(tenantId) }, sk: { S: sortKey } },
					UpdateExpression: "SET claimed_at = :now",
					ConditionExpression: "claimed_at = :seen AND #status = :claimed",
					ExpressionAttributeNames: { "#status": "status" },
					ExpressionAttributeValues: { ":now": { S: now.toISOString() }, ":seen": { S: record.claimedAt.toISOString() }, ":claimed": { S: "claimed" } },
				}),
			);
			return { kind: "claimed" };
		} catch (error) {
			if (error instanceof ConditionalCheckFailedException) return { kind: "in_flight" };
			throw error;
		}
	}

	async completeInbound(tenantId: string, bindingId: string, externalMessageId: string, result: { channelId: string; messageId: string; turnId: string | null }): Promise<void> {
		await this.client.send(
			new UpdateItemCommand({
				TableName: this.tableName,
				Key: { pk: { S: channelsPartition(tenantId) }, sk: { S: `inbound#${bindingId}#${externalMessageId}` } },
				UpdateExpression: "SET #status = :done, channel_id = :channel, message_id = :message" + (result.turnId === null ? "" : ", turn_id = :turn"),
				ExpressionAttributeNames: { "#status": "status" },
				ExpressionAttributeValues: {
					":done": { S: "done" },
					":channel": { S: result.channelId },
					":message": { S: result.messageId },
					...(result.turnId === null ? {} : { ":turn": { S: result.turnId } }),
				},
			}),
		);
	}

	async putDeliveryIfAbsent(delivery: DeliveryRecord): Promise<boolean> {
		try {
			await retryTransient(() =>
				this.client.send(
					new TransactWriteItemsCommand({
						TransactItems: [
							{ Put: { TableName: this.tableName, Item: encodeDelivery(delivery), ConditionExpression: "attribute_not_exists(pk)" } },
							{
								Put: {
									TableName: this.tableName,
									Item: { pk: { S: deliveriesPartition(delivery.tenantId) }, sk: { S: openSortKey(delivery) }, tenant_id: { S: delivery.tenantId }, message_id: { S: delivery.messageId }, binding_id: { S: delivery.bindingId } },
								},
							},
						],
					}),
				),
			);
			return true;
		} catch (error) {
			if (error instanceof TransactionCanceledException) return false;
			throw error;
		}
	}

	async getDelivery(tenantId: string, messageId: string, bindingId: string): Promise<DeliveryRecord | null> {
		const item = await this.get(deliveriesPartition(tenantId), deliverySortKey(messageId, bindingId));
		return item === null ? null : decodeDelivery(item);
	}

	async putDelivery(delivery: DeliveryRecord): Promise<void> {
		await this.client.send(new PutItemCommand({ TableName: this.tableName, Item: encodeDelivery(delivery) }));
		if (!OPEN_STATES.includes(delivery.state)) {
			await this.client.send(
				new DeleteItemCommand({ TableName: this.tableName, Key: { pk: { S: deliveriesPartition(delivery.tenantId) }, sk: { S: openSortKey(delivery) } } }),
			);
		}
	}

	async listOpenDeliveries(tenantId: string): Promise<DeliveryRecord[]> {
		const open = await this.query(deliveriesPartition(tenantId), "open#");
		const deliveries: DeliveryRecord[] = [];
		for (const entry of open) {
			const delivery = await this.getDelivery(tenantId, required(entry, "message_id"), required(entry, "binding_id"));
			if (delivery !== null && OPEN_STATES.includes(delivery.state)) deliveries.push(delivery);
		}
		return deliveries;
	}

	async listDeliveries(tenantId: string, bindingId: string): Promise<DeliveryRecord[]> {
		const items = await this.query(deliveriesPartition(tenantId), "delivery#");
		return items
			.map(decodeDelivery)
			.filter((delivery) => delivery.bindingId === bindingId)
			.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.messageId.localeCompare(right.messageId));
	}

	async putProviderMessageIndex(provider: TransportProvider, providerMessageId: string, target: { tenantId: string; messageId: string; bindingId: string }): Promise<void> {
		await this.client.send(
			new PutItemCommand({
				TableName: this.tableName,
				Item: {
					pk: { S: providerMessagePartition(provider, providerMessageId) },
					sk: { S: "delivery" },
					tenant_id: { S: target.tenantId },
					message_id: { S: target.messageId },
					binding_id: { S: target.bindingId },
				},
			}),
		);
	}

	async getDeliveryByProviderMessage(provider: TransportProvider, providerMessageId: string): Promise<DeliveryRecord | null> {
		const index = await this.get(providerMessagePartition(provider, providerMessageId), "delivery");
		if (index === null) return null;
		return this.getDelivery(required(index, "tenant_id"), required(index, "message_id"), required(index, "binding_id"));
	}
}
