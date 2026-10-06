import {
	type AttributeValue,
	ConditionalCheckFailedException,
	type DynamoDBClient,
	GetItemCommand,
	QueryCommand,
	TransactionCanceledException,
	TransactWriteItemsCommand,
	UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import type { ComputerActionStore } from "../domain/actions.ts";
import { type ComputerAction, decodeAction, encodeAction, encodeActionIndex } from "./codecs/action.ts";
import { computerActionKey, turnActionIndexKey } from "./keys.ts";

type Item = Record<string, AttributeValue>;

const epochSeconds = (moment: Date): string => String(Math.floor(moment.getTime() / 1000));

const keyOf = (key: { pk: string; sk: string }): Item => ({ pk: { S: key.pk }, sk: { S: key.sk } });

/** The Messaging table implementation of ComputerActionStore. */
export class DynamoComputerActionStore implements ComputerActionStore {
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

	async createIfAbsent(action: ComputerAction): Promise<{ action: ComputerAction; created: boolean }> {
		try {
			await this.client.send(
				new TransactWriteItemsCommand({
					TransactItems: [
						{
							Put: {
								TableName: this.tableName,
								Item: encodeActionIndex(action),
								ConditionExpression: "attribute_not_exists(pk)",
							},
						},
						{ Put: { TableName: this.tableName, Item: encodeAction(action) } },
					],
				}),
			);
			return { action, created: true };
		} catch (error) {
			if (!(error instanceof TransactionCanceledException)) throw error;
		}
		const existing = await this.getByCall(action.tenantId, action.turnId, action.callId);
		if (existing === null) {
			throw new Error(`Computer action for call ${JSON.stringify(action.callId)} could not be created or found.`);
		}
		return { action: existing, created: false };
	}

	async getByCall(tenantId: string, turnId: string, callId: string): Promise<ComputerAction | null> {
		const index = await this.client.send(
			new GetItemCommand({
				TableName: this.tableName,
				Key: keyOf(turnActionIndexKey(tenantId, turnId, callId)),
				ConsistentRead: true,
			}),
		);
		const actionId = index.Item?.action_id?.S;
		return actionId === undefined ? null : this.get(tenantId, actionId);
	}

	async get(tenantId: string, actionId: string): Promise<ComputerAction | null> {
		const response = await this.client.send(
			new GetItemCommand({ TableName: this.tableName, Key: keyOf(computerActionKey(tenantId, actionId)), ConsistentRead: true }),
		);
		return response.Item === undefined ? null : decodeAction(response.Item);
	}

	async listOpen(tenantId: string): Promise<ComputerAction[]> {
		const actions: ComputerAction[] = [];
		let exclusiveStartKey: Item | undefined;
		do {
			const response = await this.client.send(
				new QueryCommand({
					TableName: this.tableName,
					KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
					FilterExpression: "#status <> :done",
					ExpressionAttributeNames: { "#status": "status" },
					ExpressionAttributeValues: {
						":pk": { S: `${tenantId}#computer#actions` },
						":prefix": { S: "act#" },
						":done": { S: "done" },
					},
					ConsistentRead: true,
					ExclusiveStartKey: exclusiveStartKey,
				}),
			);
			actions.push(...(response.Items ?? []).map(decodeAction));
			exclusiveStartKey = response.LastEvaluatedKey;
		} while (exclusiveStartKey !== undefined);
		return actions.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.actionId.localeCompare(right.actionId));
	}

	async listForTurn(tenantId: string, turnId: string): Promise<ComputerAction[]> {
		const actions: ComputerAction[] = [];
		let exclusiveStartKey: Item | undefined;
		do {
			const response = await this.client.send(
				new QueryCommand({
					TableName: this.tableName,
					KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
					ExpressionAttributeValues: { ":pk": { S: `${tenantId}#turn#${turnId}` }, ":prefix": { S: "act#" } },
					ConsistentRead: true,
					ExclusiveStartKey: exclusiveStartKey,
				}),
			);
			for (const item of response.Items ?? []) {
				const action = await this.get(tenantId, item.action_id!.S!);
				if (action !== null) actions.push(action);
			}
			exclusiveStartKey = response.LastEvaluatedKey;
		} while (exclusiveStartKey !== undefined);
		return actions.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.actionId.localeCompare(right.actionId));
	}

	async claim(request: Parameters<ComputerActionStore["claim"]>[0]): Promise<ComputerAction | null> {
		return this.update(request.tenantId, request.actionId, {
			update: "SET #status = :claimed, claimed_by = :worker, lease_expires_at = :lease",
			condition: "#status = :requested",
			values: {
				":claimed": { S: "claimed" },
				":requested": { S: "requested" },
				":worker": { S: request.workerId },
				":lease": { N: epochSeconds(request.leaseExpiresAt) },
			},
		});
	}

	async complete(request: Parameters<ComputerActionStore["complete"]>[0]): Promise<ComputerAction | null> {
		const values: Record<string, AttributeValue> = {
			":done": { S: "done" },
			":claimed": { S: "claimed" },
			":result": { S: request.result },
			":isError": { BOOL: request.resultIsError },
			":completedAt": { N: epochSeconds(request.now) },
		};
		let condition = "#status <> :done";
		if (request.workerId !== null) {
			condition = "#status = :claimed AND claimed_by = :worker";
			values[":worker"] = { S: request.workerId };
		} else {
			delete values[":claimed"];
		}
		return this.update(request.tenantId, request.actionId, {
			update:
				"SET #status = :done, #result = :result, result_is_error = :isError, completed_at = :completedAt REMOVE lease_expires_at",
			condition,
			values,
		});
	}

	async renew(request: Parameters<ComputerActionStore["renew"]>[0]): Promise<ComputerAction | null> {
		return this.update(request.tenantId, request.actionId, {
			update: "SET lease_expires_at = :lease",
			condition: "#status = :claimed AND claimed_by = :worker",
			values: {
				":claimed": { S: "claimed" },
				":worker": { S: request.workerId },
				":lease": { N: epochSeconds(request.leaseExpiresAt) },
			},
		});
	}

	async release(tenantId: string, actionId: string): Promise<ComputerAction | null> {
		return this.update(tenantId, actionId, {
			update: "SET #status = :requested REMOVE claimed_by, lease_expires_at",
			condition: "#status = :claimed",
			values: { ":requested": { S: "requested" }, ":claimed": { S: "claimed" } },
		});
	}

	private async update(
		tenantId: string,
		actionId: string,
		change: { update: string; condition: string; values: Record<string, AttributeValue> },
	): Promise<ComputerAction | null> {
		try {
			const response = await this.client.send(
				new UpdateItemCommand({
					TableName: this.tableName,
					Key: keyOf(computerActionKey(tenantId, actionId)),
					UpdateExpression: change.update,
					ConditionExpression: `attribute_exists(pk) AND ${change.condition}`,
					ExpressionAttributeNames: {
						"#status": "status",
						...(change.update.includes("#result") ? { "#result": "result" } : {}),
					},
					ExpressionAttributeValues: change.values,
					ReturnValues: "ALL_NEW",
				}),
			);
			return decodeAction(response.Attributes!);
		} catch (error) {
			if (error instanceof ConditionalCheckFailedException) return null;
			throw error;
		}
	}
}
