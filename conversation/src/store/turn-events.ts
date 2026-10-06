import { type AttributeValue, type DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import type { PendingComputerTool, TurnEvent, TurnEventKind } from "../domain/turns.ts";

/**
 * Partition key of a turn's items, shared by the control record and its events.
 *
 * @param tenantId Organization.
 * @param turnId Turn.
 * @returns `<tenant>#turn#<turn>`.
 */
export const turnItemPartitionKey = (tenantId: string, turnId: string): string => `${tenantId}#turn#${turnId}`;

/**
 * Sort key of a turn event.
 *
 * @param seq Sequence of the event within its turn.
 * @returns `evt#` and the sequence zero padded to ten digits.
 */
export const turnEventSortKey = (seq: number): string => `evt#${String(seq).padStart(10, "0")}`;

const EVENT_SORT_KEY_PREFIX = "evt#";

/**
 * The DynamoDB item of one turn event, with its time to live in `expires_at`.
 *
 * @param event The event.
 * @param expiresAt When DynamoDB may expire the item.
 * @returns The item attributes.
 */
export function turnEventItem(event: TurnEvent, expiresAt: Date): Record<string, AttributeValue> {
	const item: Record<string, AttributeValue> = {
		pk: { S: turnItemPartitionKey(event.tenantId, event.turnId) },
		sk: { S: turnEventSortKey(event.seq) },
		tenant_id: { S: event.tenantId },
		turn_id: { S: event.turnId },
		channel_id: { S: event.channelId },
		event_id: { S: event.eventId },
		seq: { N: String(event.seq) },
		kind: { S: event.kind },
		expires_at: { N: String(Math.floor(expiresAt.getTime() / 1000)) },
	};
	if (event.token !== undefined) {
		item.token = { S: event.token };
	}
	if (event.messageSeq !== undefined) {
		item.message_seq = { N: String(event.messageSeq) };
	}
	if (event.body !== undefined) {
		item.body = { S: event.body };
	}
	if (event.actionId !== undefined) {
		item.action_id = { S: event.actionId };
	}
	if (event.attemptId !== undefined) {
		item.attempt_id = { S: event.attemptId };
	}
	if (event.pendingComputerTool !== undefined) {
		item.pending_computer_tool = { S: encodePendingComputerTool(event.pendingComputerTool) };
	}
	return item;
}

/** The stored text of a pending computer tool, keys sorted so equal tools encode equally. */
export function encodePendingComputerTool(tool: PendingComputerTool): string {
	return JSON.stringify({
		action_id: tool.actionId,
		arguments: Object.fromEntries(Object.entries(tool.arguments).sort(([left], [right]) => left.localeCompare(right))),
		tool_name: tool.toolName,
	});
}

/** Read a pending computer tool from its stored text. */
export function decodePendingComputerTool(text: string): PendingComputerTool {
	const parsed = JSON.parse(text) as { action_id: string; tool_name: string; arguments: Record<string, string> };
	return { actionId: parsed.action_id, toolName: parsed.tool_name, arguments: parsed.arguments };
}

/** Read one turn event from its DynamoDB item. */
export function turnEventFromItem(item: Record<string, AttributeValue>): TurnEvent {
	const event: TurnEvent = {
		eventId: item.event_id!.S!,
		tenantId: item.tenant_id!.S!,
		turnId: item.turn_id!.S!,
		channelId: item.channel_id!.S!,
		seq: Number(item.seq!.N),
		kind: item.kind!.S as TurnEventKind,
	};
	if (item.token?.S !== undefined) {
		event.token = item.token.S;
	}
	if (item.message_seq?.N !== undefined) {
		event.messageSeq = Number(item.message_seq.N);
	}
	if (item.body?.S !== undefined) {
		event.body = item.body.S;
	}
	if (item.action_id?.S !== undefined) {
		event.actionId = item.action_id.S;
	}
	if (item.attempt_id?.S !== undefined) {
		event.attemptId = item.attempt_id.S;
	}
	if (item.pending_computer_tool?.S !== undefined) {
		event.pendingComputerTool = decodePendingComputerTool(item.pending_computer_tool.S);
	}
	return event;
}

/**
 * List a turn's events after a sequence in sequence order.
 *
 * @param client DynamoDB client.
 * @param tableName The Messaging table.
 * @param tenantId Organization.
 * @param turnId Turn.
 * @param afterSeq Exclusive cursor; 0 lists every event.
 * @returns The events, oldest first.
 */
export async function listTurnEventItems(
	client: DynamoDBClient,
	tableName: string,
	tenantId: string,
	turnId: string,
	afterSeq: number,
): Promise<TurnEvent[]> {
	const events: TurnEvent[] = [];
	let exclusiveStartKey: Record<string, AttributeValue> | undefined;
	do {
		const page = await client.send(
			new QueryCommand({
				TableName: tableName,
				KeyConditionExpression: "pk = :pk AND sk BETWEEN :after AND :end",
				ExpressionAttributeValues: {
					":pk": { S: turnItemPartitionKey(tenantId, turnId) },
					":after": { S: turnEventSortKey(afterSeq + 1) },
					":end": { S: `${EVENT_SORT_KEY_PREFIX}~` },
				},
				ConsistentRead: true,
				ExclusiveStartKey: exclusiveStartKey,
			}),
		);
		for (const item of page.Items ?? []) {
			events.push(turnEventFromItem(item));
		}
		exclusiveStartKey = page.LastEvaluatedKey;
	} while (exclusiveStartKey !== undefined);
	return events;
}
