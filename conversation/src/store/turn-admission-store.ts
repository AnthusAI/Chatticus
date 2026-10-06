import {
	type AttributeValue,
	type DynamoDBClient,
	GetItemCommand,
	TransactionCanceledException,
	TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import type { OpenTurnState, StartTurnRequest, TurnAdmission } from "../domain/turn-admission.ts";
import { MAILBOX_PUT_CONDITION, type MailboxItem, mailboxItemAttributes } from "../pi/mailbox.ts";
import { TURN_EVENT_TTL_SECONDS } from "../domain/turns.ts";
import { formatIsoDateTime } from "./codecs/util.ts";
import { turnEventItem, turnItemPartitionKey } from "./turn-events.ts";
import { turnPointerKey } from "./turn-store.ts";

/**
 * Partition key of a turn control record.
 *
 * @param tenantId Organization.
 * @param turnId Turn.
 * @returns `<tenant>#turn#<turn>`.
 */
export const turnPartitionKey = turnItemPartitionKey;

/**
 * Key of the per-(channel, bot) pointer to that bot's current turn on the channel.
 *
 * @param tenantId Organization.
 * @param channelId Channel.
 * @param botId Bot.
 * @returns The pointer item key.
 */
export const activeTurnPointerKey = (
	tenantId: string,
	channelId: string,
	botId: string,
): { pk: string; sk: string } => turnPointerKey(tenantId, channelId, "active", botId);

const ACTIVE_STATUS = "active";

const pointerItem = (key: { pk: string; sk: string }, request: StartTurnRequest): Record<string, AttributeValue> => ({
	pk: { S: key.pk },
	sk: { S: key.sk },
	tenant_id: { S: request.tenantId },
	channel_id: { S: request.channelId },
	bot_id: { S: request.botId },
	turn_id: { S: request.turnId },
});

/** The Messaging table implementation of TurnAdmission. */
export class DynamoTurnAdmission implements TurnAdmission {
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

	async openTurn(tenantId: string, channelId: string, botId: string): Promise<OpenTurnState | null> {
		const pointerKey = activeTurnPointerKey(tenantId, channelId, botId);
		const pointer = await this.client.send(
			new GetItemCommand({
				TableName: this.tableName,
				Key: { pk: { S: pointerKey.pk }, sk: { S: pointerKey.sk } },
				ConsistentRead: true,
			}),
		);
		const pointerTurnId = pointer.Item?.turn_id?.S;
		if (pointerTurnId === undefined) {
			return null;
		}
		const turn = await this.client.send(
			new GetItemCommand({
				TableName: this.tableName,
				Key: { pk: { S: turnPartitionKey(tenantId, pointerTurnId) }, sk: { S: "meta" } },
				ConsistentRead: true,
			}),
		);
		return {
			pointerTurnId,
			active: turn.Item?.status?.S === ACTIVE_STATUS,
			closing: turn.Item?.closing?.BOOL === true,
		};
	}

	async startTurn(request: StartTurnRequest): Promise<boolean> {
		const pointerKey = activeTurnPointerKey(request.tenantId, request.channelId, request.botId);
		const pointerCondition =
			request.expectedPointerTurnId === null
				? { ConditionExpression: "attribute_not_exists(pk)" }
				: {
						ConditionExpression: "turn_id = :expected",
						ExpressionAttributeValues: { ":expected": { S: request.expectedPointerTurnId } },
					};
		try {
			await this.client.send(
				new TransactWriteItemsCommand({
					TransactItems: [
						{
							Put: {
								TableName: this.tableName,
								Item: {
									pk: { S: turnPartitionKey(request.tenantId, request.turnId) },
									sk: { S: "meta" },
									tenant_id: { S: request.tenantId },
									turn_id: { S: request.turnId },
									channel_id: { S: request.channelId },
									bot_id: { S: request.botId },
									status: { S: ACTIVE_STATUS },
									prompt_message_seq: { N: String(request.promptMessageSeq) },
									attempt: { N: "0" },
									next_event_seq: { N: "2" },
									recovery_attempts: { N: "0" },
									created_at: { S: formatIsoDateTime(request.createdAt) },
								},
								ConditionExpression: "attribute_not_exists(pk)",
							},
						},
						{
							Put: {
								TableName: this.tableName,
								Item: pointerItem(pointerKey, request),
								...pointerCondition,
							},
						},
						{
							Put: {
								TableName: this.tableName,
								Item: pointerItem(turnPointerKey(request.tenantId, request.channelId, "latest", request.botId), request),
							},
						},
						{
							Put: {
								TableName: this.tableName,
								Item: pointerItem(turnPointerKey(request.tenantId, request.channelId, "active", null), request),
							},
						},
						{
							Put: {
								TableName: this.tableName,
								Item: pointerItem(turnPointerKey(request.tenantId, request.channelId, "latest", null), request),
							},
						},
						{
							Put: {
								TableName: this.tableName,
								Item: turnEventItem(
									{
										eventId: request.startedEventId,
										tenantId: request.tenantId,
										turnId: request.turnId,
										channelId: request.channelId,
										seq: 1,
										kind: "turn.started",
									},
									new Date(request.createdAt.getTime() + TURN_EVENT_TTL_SECONDS * 1000),
								),
								ConditionExpression: "attribute_not_exists(pk)",
							},
						},
					],
				}),
			);
			return true;
		} catch (error) {
			if (error instanceof TransactionCanceledException) {
				return false;
			}
			throw error;
		}
	}

	async steerTurn(turnId: string, item: MailboxItem): Promise<boolean> {
		try {
			await this.client.send(
				new TransactWriteItemsCommand({
					TransactItems: [
						{
							ConditionCheck: {
								TableName: this.tableName,
								Key: { pk: { S: turnPartitionKey(item.tenantId, turnId) }, sk: { S: "meta" } },
								ConditionExpression: "#status = :active AND attribute_not_exists(closing)",
								ExpressionAttributeNames: { "#status": "status" },
								ExpressionAttributeValues: { ":active": { S: ACTIVE_STATUS } },
							},
						},
						{
							Put: {
								TableName: this.tableName,
								Item: mailboxItemAttributes(item),
								ConditionExpression: MAILBOX_PUT_CONDITION,
								ExpressionAttributeValues: { ":messageId": { S: item.messageId } },
							},
						},
					],
				}),
			);
			return true;
		} catch (error) {
			if (error instanceof TransactionCanceledException) {
				const reasons = error.CancellationReasons ?? [];
				if (reasons[0]?.Code !== "ConditionalCheckFailed" && reasons[1]?.Code === "ConditionalCheckFailed") {
					throw new Error(`mailbox seq ${item.seq} already holds a different message`, { cause: error });
				}
				return false;
			}
			throw error;
		}
	}
}
