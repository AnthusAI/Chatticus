import {
	type AttributeValue,
	ConditionalCheckFailedException,
	DeleteItemCommand,
	type DynamoDBClient,
	GetItemCommand,
	TransactionCanceledException,
	TransactWriteItemsCommand,
	UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { pythonRepr } from "../domain/bots.ts";
import type { ProbeObservation, Turn, TurnControlStore, TurnEvent, TurnEventDraft, TurnStatus } from "../domain/turns.ts";
import { StaleAttemptError, TurnNotFoundError, TurnTerminalError } from "../http/errors.ts";
import type { TaskCapabilityGrant } from "../policy/capability-policy.ts";
import { TURN_GRANT_SORT_KEY, decodeGrant, encodeGrant } from "./codecs/grant.ts";
import {
	decodePendingComputerTool,
	encodePendingComputerTool,
	listTurnEventItems,
	turnEventItem,
	turnItemPartitionKey,
} from "./turn-events.ts";
import { retryTransient } from "./transient-retry.ts";

const ACTIVE_STATUS = "active";
const TRANSITION_ATTEMPTS = 8;

/**
 * Key of a channel pointer to a bot's turn, or to the primary turn of the channel.
 *
 * @param tenantId Organization.
 * @param channelId Channel.
 * @param pointer Whether the pointer names the active turn or the latest turn.
 * @param botId The bot, or null for the primary pointer (the most recently started turn across bots).
 * @returns The pointer item key.
 */
export function turnPointerKey(
	tenantId: string,
	channelId: string,
	pointer: "active" | "latest",
	botId: string | null,
): { pk: string; sk: string } {
	return {
		pk: `${tenantId}#channel#${channelId}`,
		sk: botId === null ? `${pointer}_turn_primary` : `${pointer}_turn#${botId}`,
	};
}

const epochSeconds = (moment: Date): string => String(Math.floor(moment.getTime() / 1000));

const optionalString = (item: Record<string, AttributeValue>, name: string): string | null => {
	const value = item[name]?.S;
	return value !== undefined && value !== "" ? value : null;
};

const optionalNumber = (item: Record<string, AttributeValue>, name: string): number | null => {
	const value = item[name]?.N;
	return value !== undefined ? Number(value) : null;
};

const optionalDate = (item: Record<string, AttributeValue>, name: string): Date | null => {
	const seconds = optionalNumber(item, name);
	return seconds === null ? null : new Date(seconds * 1000);
};

/** Read a turn control record from its DynamoDB item. */
export function turnFromItem(item: Record<string, AttributeValue>): Turn {
	const pending = optionalString(item, "pending_computer_tool");
	return {
		turnId: item.turn_id!.S!,
		tenantId: item.tenant_id!.S!,
		channelId: item.channel_id!.S!,
		botId: item.bot_id!.S!,
		status: item.status!.S as TurnStatus,
		promptMessageSeq: optionalNumber(item, "prompt_message_seq"),
		promptAuthorId: optionalString(item, "prompt_author_id"),
		attemptId: optionalString(item, "attempt_id"),
		attempt: optionalNumber(item, "attempt") ?? 0,
		claimedBy: optionalString(item, "claimed_by"),
		leaseExpiresAt: optionalDate(item, "lease_expires_at"),
		deadlineAt: optionalDate(item, "deadline_at"),
		recoveryAttempts: optionalNumber(item, "recovery_attempts") ?? 0,
		waitingFor: optionalString(item, "waiting_for"),
		waitingSince: optionalDate(item, "waiting_since"),
		logicalEnqueueIds: [...(item.logical_enqueue_ids?.SS ?? [])],
		pendingComputerTool: pending === null ? null : decodePendingComputerTool(pending),
		storageFence: optionalNumber(item, "storage_fence"),
		nextEventSeq: optionalNumber(item, "next_event_seq") ?? 1,
		terminalReason: optionalString(item, "terminal_reason"),
		messageSeq: optionalNumber(item, "message_seq"),
		ledgerInputRecorded: optionalNumber(item, "ledger_input_recorded") ?? 0,
		ledgerOutputRecorded: optionalNumber(item, "ledger_output_recorded") ?? 0,
	};
}

type Transition = {
	tenantId: string;
	turnId: string;
	attemptId: string | null;
	/** Extra condition on the item, with its names and values, for a probe that acts on what it observed. */
	guard?: { expression: string; names: Record<string, string>; values: Record<string, AttributeValue> };
	/** The same condition checked on the record just read, so a turn that has moved on is dropped without a retry. */
	holds?: (turn: Turn) => boolean;
	draft: TurnEventDraft;
	eventId: string;
	expiresAt: Date;
	set: Record<string, AttributeValue>;
	remove: string[];
	terminal: boolean;
};

/** The Messaging table implementation of TurnControlStore. */
/**
 * Remember that a run job was requested for a turn under `enqueueId`.
 *
 * @param client DynamoDB client.
 * @param tableName The Messaging table.
 * @param tenantId Organization.
 * @param turnId Turn.
 * @param enqueueId The logical enqueue identifier.
 * @returns true the first time the identifier is recorded, false when it already was.
 * @throws TurnNotFoundError If the turn does not exist.
 */
export async function recordLogicalEnqueueOnTurn(
	client: DynamoDBClient,
	tableName: string,
	tenantId: string,
	turnId: string,
	enqueueId: string,
): Promise<boolean> {
	const key = { pk: { S: turnItemPartitionKey(tenantId, turnId) }, sk: { S: "meta" } };
	try {
		await retryTransient(() => client.send(
			new UpdateItemCommand({
				TableName: tableName,
				Key: key,
				UpdateExpression: "ADD logical_enqueue_ids :ids",
				ConditionExpression:
					"attribute_exists(pk) AND (attribute_not_exists(logical_enqueue_ids) OR NOT contains(logical_enqueue_ids, :id))",
				ExpressionAttributeValues: { ":ids": { SS: [enqueueId] }, ":id": { S: enqueueId } },
			}),
		));
		return true;
	} catch (error) {
		if (!(error instanceof ConditionalCheckFailedException)) {
			throw error;
		}
	}
	const existing = await client.send(new GetItemCommand({ TableName: tableName, Key: key, ConsistentRead: true }));
	if (existing.Item === undefined) {
		throw new TurnNotFoundError(`Turn ${pythonRepr(turnId)} does not exist.`);
	}
	return false;
}

export class DynamoTurnControlStore implements TurnControlStore {
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

	private metaKey(tenantId: string, turnId: string): Record<string, AttributeValue> {
		return { pk: { S: turnItemPartitionKey(tenantId, turnId) }, sk: { S: "meta" } };
	}

	async getTurn(tenantId: string, turnId: string): Promise<Turn | null> {
		const result = await this.client.send(
			new GetItemCommand({ TableName: this.tableName, Key: this.metaKey(tenantId, turnId), ConsistentRead: true }),
		);
		return result.Item === undefined ? null : turnFromItem(result.Item);
	}

	async claimTurn(request: Parameters<TurnControlStore["claimTurn"]>[0]): Promise<Turn | null> {
		const claimedByClause = request.claimedBy === null ? "" : ", claimed_by = :claimedBy";
		const removeClaimedBy = request.claimedBy === null ? " REMOVE claimed_by" : "";
		const values: Record<string, AttributeValue> = {
			":attemptId": { S: request.attemptId },
			":lease": { N: epochSeconds(request.leaseExpiresAt) },
			":deadline": { N: epochSeconds(request.deadlineAt) },
			":now": { N: epochSeconds(request.now) },
			":active": { S: ACTIVE_STATUS },
			":one": { N: "1" },
		};
		if (request.claimedBy !== null) {
			values[":claimedBy"] = { S: request.claimedBy };
		}
		try {
			const result = await retryTransient(() => this.client.send(
				new UpdateItemCommand({
					TableName: this.tableName,
					Key: this.metaKey(request.tenantId, request.turnId),
					UpdateExpression: `SET attempt_id = :attemptId, lease_expires_at = :lease, deadline_at = :deadline${claimedByClause} ADD attempt :one${removeClaimedBy}`,
					ConditionExpression:
						"attribute_exists(pk) AND #status = :active AND attribute_not_exists(waiting_for) AND (attribute_not_exists(lease_expires_at) OR lease_expires_at <= :now)",
					ExpressionAttributeNames: { "#status": "status" },
					ExpressionAttributeValues: values,
					ReturnValues: "ALL_NEW",
				}),
			));
			return turnFromItem(result.Attributes!);
		} catch (error) {
			if (error instanceof ConditionalCheckFailedException) {
				return null;
			}
			throw error;
		}
	}

	async renewTurn(request: Parameters<TurnControlStore["renewTurn"]>[0]): Promise<Turn | null> {
		try {
			const result = await retryTransient(() => this.client.send(
				new UpdateItemCommand({
					TableName: this.tableName,
					Key: this.metaKey(request.tenantId, request.turnId),
					UpdateExpression: "SET lease_expires_at = :lease, deadline_at = :deadline",
					ConditionExpression: "attempt_id = :attemptId AND #status = :active",
					ExpressionAttributeNames: { "#status": "status" },
					ExpressionAttributeValues: {
						":lease": { N: epochSeconds(request.leaseExpiresAt) },
						":deadline": { N: epochSeconds(request.deadlineAt) },
						":attemptId": { S: request.attemptId },
						":active": { S: ACTIVE_STATUS },
					},
					ReturnValues: "ALL_NEW",
				}),
			));
			return turnFromItem(result.Attributes!);
		} catch (error) {
			if (error instanceof ConditionalCheckFailedException) {
				return null;
			}
			throw error;
		}
	}

	async recordStorageFence(tenantId: string, turnId: string, attemptId: string, storageFence: number): Promise<void> {
		try {
			await retryTransient(() => this.client.send(
				new UpdateItemCommand({
					TableName: this.tableName,
					Key: this.metaKey(tenantId, turnId),
					UpdateExpression: "SET storage_fence = :fence",
					ConditionExpression: "attempt_id = :attemptId AND #status = :active",
					ExpressionAttributeNames: { "#status": "status" },
					ExpressionAttributeValues: {
						":fence": { N: String(storageFence) },
						":attemptId": { S: attemptId },
						":active": { S: ACTIVE_STATUS },
					},
				}),
			));
		} catch (error) {
			if (error instanceof ConditionalCheckFailedException) {
				throw await this.rejection(tenantId, turnId, attemptId);
			}
			throw error;
		}
	}

	async appendEvent(request: Parameters<TurnControlStore["appendEvent"]>[0]): Promise<TurnEvent> {
		return this.transition({ ...request, set: {}, remove: [], terminal: false });
	}

	async completeTurn(request: Parameters<TurnControlStore["completeTurn"]>[0]): Promise<TurnEvent> {
		return this.transition({
			tenantId: request.tenantId,
			turnId: request.turnId,
			attemptId: request.attemptId,
			draft: { kind: "turn.completed", messageSeq: request.messageSeq, body: request.body },
			eventId: request.eventId,
			expiresAt: request.expiresAt,
			set: { status: { S: "completed" }, message_seq: { N: String(request.messageSeq) } },
			remove: ["waiting_for", "pending_computer_tool"],
			terminal: true,
		});
	}

	async failTurn(request: Parameters<TurnControlStore["failTurn"]>[0]): Promise<TurnEvent> {
		return this.transition({
			tenantId: request.tenantId,
			turnId: request.turnId,
			attemptId: request.attemptId,
			draft: { kind: "turn.failed", body: request.reason },
			eventId: request.eventId,
			expiresAt: request.expiresAt,
			set: { status: { S: "failed" }, terminal_reason: { S: request.reason } },
			remove: ["claimed_by", "lease_expires_at"],
			terminal: true,
		});
	}

	async parkTurn(request: Parameters<TurnControlStore["parkTurn"]>[0]): Promise<TurnEvent> {
		return this.transition({
			tenantId: request.tenantId,
			turnId: request.turnId,
			attemptId: request.attemptId,
			draft: { kind: "turn.waiting", body: request.gate, pendingComputerTool: request.pendingComputerTool },
			eventId: request.eventId,
			expiresAt: request.expiresAt,
			set: {
				waiting_for: { S: request.gate },
				waiting_since: { N: epochSeconds(request.now) },
				pending_computer_tool: { S: encodePendingComputerTool(request.pendingComputerTool) },
			},
			remove: ["attempt_id", "claimed_by", "lease_expires_at"],
			terminal: false,
		});
	}

	async resumeTurn(tenantId: string, turnId: string): Promise<Turn | null> {
		try {
			const result = await retryTransient(() => this.client.send(
				new UpdateItemCommand({
					TableName: this.tableName,
					Key: this.metaKey(tenantId, turnId),
					UpdateExpression: "REMOVE waiting_for, waiting_since, pending_computer_tool",
					ConditionExpression: "attribute_exists(pk) AND #status = :active AND attribute_exists(waiting_for)",
					ExpressionAttributeNames: { "#status": "status" },
					ExpressionAttributeValues: { ":active": { S: ACTIVE_STATUS } },
					ReturnValues: "ALL_NEW",
				}),
			));
			return turnFromItem(result.Attributes!);
		} catch (error) {
			if (error instanceof ConditionalCheckFailedException) {
				return null;
			}
			throw error;
		}
	}

	async beginClosing(tenantId: string, turnId: string, attemptId: string): Promise<void> {
		try {
			await retryTransient(() => this.client.send(
				new UpdateItemCommand({
					TableName: this.tableName,
					Key: this.metaKey(tenantId, turnId),
					UpdateExpression: "SET closing = :closing",
					ConditionExpression: "attempt_id = :attemptId AND #status = :active",
					ExpressionAttributeNames: { "#status": "status" },
					ExpressionAttributeValues: {
						":closing": { BOOL: true },
						":attemptId": { S: attemptId },
						":active": { S: ACTIVE_STATUS },
					},
				}),
			));
		} catch (error) {
			if (error instanceof ConditionalCheckFailedException) {
				throw await this.rejection(tenantId, turnId, attemptId);
			}
			throw error;
		}
	}

	async reconcileTurn(request: Parameters<TurnControlStore["reconcileTurn"]>[0]): Promise<TurnEvent> {
		return this.transition({
			tenantId: request.tenantId,
			turnId: request.turnId,
			attemptId: request.attemptId,
			draft: { kind: "turn.reconciling", body: request.reason },
			eventId: request.eventId,
			expiresAt: request.expiresAt,
			set: { status: { S: "reconciling" }, terminal_reason: { S: request.reason } },
			remove: ["claimed_by", "lease_expires_at"],
			terminal: false,
		});
	}

	async recoverExpiredTurn(request: Parameters<TurnControlStore["recoverExpiredTurn"]>[0]): Promise<Turn | null> {
		const values: Record<string, AttributeValue> = {
			":active": { S: ACTIVE_STATUS },
			":now": { N: epochSeconds(request.now) },
			":deadline": { N: epochSeconds(request.deadlineAt) },
			":observedRecovery": { N: String(request.observed.recoveryAttempts) },
			":nextRecovery": { N: String(request.observed.recoveryAttempts + 1) },
		};
		let attemptCondition = "attribute_not_exists(attempt_id)";
		if (request.observed.attemptId !== null) {
			attemptCondition = "attempt_id = :observedAttempt";
			values[":observedAttempt"] = { S: request.observed.attemptId };
		}
		try {
			const result = await retryTransient(() => this.client.send(
				new UpdateItemCommand({
					TableName: this.tableName,
					Key: this.metaKey(request.tenantId, request.turnId),
					UpdateExpression:
						"SET recovery_attempts = :nextRecovery, deadline_at = :deadline REMOVE attempt_id, claimed_by, lease_expires_at",
					ConditionExpression: `attribute_exists(pk) AND #status = :active AND attribute_not_exists(waiting_for) AND (attribute_not_exists(lease_expires_at) OR lease_expires_at <= :now) AND ${attemptCondition} AND recovery_attempts = :observedRecovery`,
					ExpressionAttributeNames: { "#status": "status" },
					ExpressionAttributeValues: values,
					ReturnValues: "ALL_NEW",
				}),
			));
			return turnFromItem(result.Attributes!);
		} catch (error) {
			if (error instanceof ConditionalCheckFailedException) {
				return null;
			}
			throw error;
		}
	}

	async failStaleTurn(request: Parameters<TurnControlStore["failStaleTurn"]>[0]): Promise<TurnEvent | null> {
		const nowSeconds = Math.floor(request.now.getTime() / 1000);
		const leaseExpired = (turn: Turn): boolean =>
			turn.waitingFor === null &&
			(turn.leaseExpiresAt === null || Math.floor(turn.leaseExpiresAt.getTime() / 1000) <= nowSeconds);
		const holds = (turn: Turn): boolean =>
			turn.recoveryAttempts === request.observed.recoveryAttempts &&
			(request.condition === "waiting" ? turn.waitingFor !== null : leaseExpired(turn));
		const guardValues: Record<string, AttributeValue> = {};
		let guardExpression = "attribute_exists(waiting_for)";
		if (request.condition === "lease_expired") {
			guardExpression = "attribute_not_exists(waiting_for) AND (attribute_not_exists(lease_expires_at) OR lease_expires_at <= :guardNow)";
			guardValues[":guardNow"] = { N: String(nowSeconds) };
		}
		const guard = { expression: guardExpression, names: {}, values: guardValues };
		try {
			return await this.transition({
				tenantId: request.tenantId,
				turnId: request.turnId,
				attemptId: request.observed.attemptId,
				guard,
				holds,
				draft: { kind: "turn.failed", body: request.reason },
				eventId: request.eventId,
				expiresAt: request.expiresAt,
				set: { status: { S: "failed" }, terminal_reason: { S: request.reason } },
				remove: ["claimed_by", "lease_expires_at"],
				terminal: true,
			});
		} catch (error) {
			if (error instanceof StaleAttemptError || error instanceof TurnTerminalError || error instanceof TurnNotFoundError) {
				return null;
			}
			throw error;
		}
	}

	async relinquishTurn(request: Parameters<TurnControlStore["relinquishTurn"]>[0]): Promise<TurnEvent> {
		return this.transition({
			tenantId: request.tenantId,
			turnId: request.turnId,
			attemptId: request.attemptId,
			draft: { kind: "attempt.relinquished", attemptId: request.attemptId },
			eventId: request.eventId,
			expiresAt: request.expiresAt,
			set: {},
			remove: ["attempt_id", "claimed_by", "lease_expires_at"],
			terminal: false,
		});
	}

	async recordLogicalEnqueue(tenantId: string, turnId: string, enqueueId: string): Promise<boolean> {
		return recordLogicalEnqueueOnTurn(this.client, this.tableName, tenantId, turnId, enqueueId);
	}

	async listEvents(tenantId: string, turnId: string, afterSeq: number): Promise<TurnEvent[]> {
		return listTurnEventItems(this.client, this.tableName, tenantId, turnId, afterSeq);
	}

	async getGrant(tenantId: string, turnId: string): Promise<TaskCapabilityGrant | null> {
		const result = await this.client.send(
			new GetItemCommand({
				TableName: this.tableName,
				Key: { pk: { S: turnItemPartitionKey(tenantId, turnId) }, sk: { S: TURN_GRANT_SORT_KEY } },
				ConsistentRead: true,
			}),
		);
		return result.Item === undefined ? null : decodeGrant(result.Item);
	}

	async replaceGrant(request: Parameters<TurnControlStore["replaceGrant"]>[0]): Promise<TurnEvent> {
		for (let attempt = 0; attempt < TRANSITION_ATTEMPTS; attempt += 1) {
			const current = await this.getTurn(request.tenantId, request.turnId);
			if (current === null) {
				throw new TurnNotFoundError(`Turn ${pythonRepr(request.turnId)} does not exist.`);
			}
			if (current.status !== ACTIVE_STATUS) {
				throw new TurnTerminalError(`Turn ${pythonRepr(request.turnId)} is not active.`);
			}
			const event: TurnEvent = {
				eventId: request.eventId,
				tenantId: current.tenantId,
				turnId: current.turnId,
				channelId: current.channelId,
				seq: current.nextEventSeq,
				kind: "turn.grant.replaced",
				body: request.body,
			};
			try {
				await retryTransient(() => this.client.send(
					new TransactWriteItemsCommand({
						TransactItems: [
							{
								Update: {
									TableName: this.tableName,
									Key: this.metaKey(request.tenantId, request.turnId),
									UpdateExpression: "SET next_event_seq = :nextSeq",
									ConditionExpression: "#status = :active AND next_event_seq = :seq",
									ExpressionAttributeNames: { "#status": "status" },
									ExpressionAttributeValues: {
										":nextSeq": { N: String(current.nextEventSeq + 1) },
										":seq": { N: String(current.nextEventSeq) },
										":active": { S: ACTIVE_STATUS },
									},
								},
							},
							{ Put: { TableName: this.tableName, Item: encodeGrant(request.tenantId, request.turnId, request.grant) } },
							{
								Put: {
									TableName: this.tableName,
									Item: turnEventItem(event, request.expiresAt),
									ConditionExpression: "attribute_not_exists(pk)",
								},
							},
						],
					}),
				));
			} catch (error) {
				if (error instanceof TransactionCanceledException) {
					continue;
				}
				throw error;
			}
			return event;
		}
		throw new Error(`Turn ${pythonRepr(request.turnId)} could not replace its grant after ${TRANSITION_ATTEMPTS} attempts.`);
	}

	async pointedTurn(
		tenantId: string,
		channelId: string,
		pointer: "active" | "latest",
		botId: string | null,
	): Promise<Turn | null> {
		const key = turnPointerKey(tenantId, channelId, pointer, botId);
		const pointed = await this.client.send(
			new GetItemCommand({
				TableName: this.tableName,
				Key: { pk: { S: key.pk }, sk: { S: key.sk } },
				ConsistentRead: true,
			}),
		);
		const turnId = pointed.Item?.turn_id?.S;
		return turnId === undefined ? null : this.getTurn(tenantId, turnId);
	}

	private async rejection(tenantId: string, turnId: string, attemptId: string | null): Promise<Error> {
		const current = await this.getTurn(tenantId, turnId);
		if (current === null) {
			return new TurnNotFoundError(`Turn ${pythonRepr(turnId)} does not exist.`);
		}
		if (current.attemptId !== attemptId) {
			return new StaleAttemptError(
				`Turn ${pythonRepr(turnId)} rejected attempt ${pythonRepr(attemptId ?? "")} (current ${pythonRepr(current.attemptId ?? "")}).`,
			);
		}
		return new TurnTerminalError(`Turn ${pythonRepr(turnId)} is not active.`);
	}

	private async transition(request: Transition): Promise<TurnEvent> {
		for (let attempt = 0; attempt < TRANSITION_ATTEMPTS; attempt += 1) {
			const current = await this.getTurn(request.tenantId, request.turnId);
			if (current === null || current.attemptId !== request.attemptId || current.status !== ACTIVE_STATUS) {
				throw await this.rejection(request.tenantId, request.turnId, request.attemptId);
			}
			if (request.holds !== undefined && !request.holds(current)) {
				throw new StaleAttemptError(`Turn ${pythonRepr(request.turnId)} is no longer as the probe observed it.`);
			}
			const event: TurnEvent = {
				eventId: request.eventId,
				tenantId: current.tenantId,
				turnId: current.turnId,
				channelId: current.channelId,
				seq: current.nextEventSeq,
				...request.draft,
			};
			const names: Record<string, string> = { "#status": "status" };
			const values: Record<string, AttributeValue> = {
				":nextSeq": { N: String(current.nextEventSeq + 1) },
				":seq": { N: String(current.nextEventSeq) },
				":active": { S: ACTIVE_STATUS },
				...(request.guard?.values ?? {}),
			};
			Object.assign(names, request.guard?.names ?? {});
			let ownerCondition = "attribute_not_exists(attempt_id)";
			if (request.attemptId !== null) {
				ownerCondition = "attempt_id = :attemptId";
				values[":attemptId"] = { S: request.attemptId };
			}
			const guardCondition = request.guard === undefined ? "" : ` AND ${request.guard.expression}`;
			const assignments = ["next_event_seq = :nextSeq"];
			for (const [name, value] of Object.entries(request.set)) {
				names[`#set_${name}`] = name;
				values[`:set_${name}`] = value;
				assignments.push(`#set_${name} = :set_${name}`);
			}
			const removals = request.remove.map((name) => {
				names[`#remove_${name}`] = name;
				return `#remove_${name}`;
			});
			const removeClause = removals.length === 0 ? "" : ` REMOVE ${removals.join(", ")}`;
			try {
				await retryTransient(() => this.client.send(
					new TransactWriteItemsCommand({
						TransactItems: [
							{
								Update: {
									TableName: this.tableName,
									Key: this.metaKey(request.tenantId, request.turnId),
									UpdateExpression: `SET ${assignments.join(", ")}${removeClause}`,
									ConditionExpression: `${ownerCondition} AND #status = :active AND next_event_seq = :seq${guardCondition}`,
									ExpressionAttributeNames: names,
									ExpressionAttributeValues: values,
								},
							},
							{
								Put: {
									TableName: this.tableName,
									Item: turnEventItem(event, request.expiresAt),
									ConditionExpression: "attribute_not_exists(pk)",
								},
							},
						],
					}),
				));
			} catch (error) {
				if (error instanceof TransactionCanceledException) {
					continue;
				}
				throw error;
			}
			if (request.terminal) {
				await this.clearActivePointers(current);
			}
			return event;
		}
		throw new Error(`Turn ${pythonRepr(request.turnId)} could not append an event after ${TRANSITION_ATTEMPTS} attempts.`);
	}

	private async clearActivePointers(turn: Turn): Promise<void> {
		for (const botId of [turn.botId, null]) {
			const key = turnPointerKey(turn.tenantId, turn.channelId, "active", botId);
			try {
				await retryTransient(() => this.client.send(
					new DeleteItemCommand({
						TableName: this.tableName,
						Key: { pk: { S: key.pk }, sk: { S: key.sk } },
						ConditionExpression: "turn_id = :turnId",
						ExpressionAttributeValues: { ":turnId": { S: turn.turnId } },
					}),
				));
			} catch (error) {
				if (!(error instanceof ConditionalCheckFailedException)) {
					throw error;
				}
			}
		}
	}
}
