import { createHash } from "node:crypto";
import {
	type AttributeValue,
	type DynamoDBClient,
	PutItemCommand,
	QueryCommand,
} from "@aws-sdk/client-dynamodb";
import type { S3Client } from "@aws-sdk/client-s3";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { IndexedStorage } from "../storage/indexed-storage.ts";
import { storageIdFor } from "../storage/storage-support.ts";
import { type ModelCallCost, readCallCostRecords } from "./call-cost.ts";

/** The sort key prefix of the per-call cost copies in a turn's partition. */
export const CALL_COST_COPY_PREFIX = "call#";

/**
 * Where the copy of a turn's per-call cost records lives: the turn's own partition in the messaging table, beside its
 * control record and events. The copy holds counters, prices and ids, never text, and has no expiry.
 */
const turnPartition = (tenantId: string, turnId: string): string => `${tenantId}#turn#${turnId}`;

/** The sort key of one record's copy; the same call always has the same key, so copying again changes nothing. */
export function callCostCopySortKey(record: ModelCallCost): string {
	const identity = [record.kind, record.entryId, record.provider, record.model, record.inputTokens, record.cacheReadTokens, record.cacheWriteTokens, record.outputTokens].join("|");
	return `${CALL_COST_COPY_PREFIX}${record.kind}#${String(record.entryId).padStart(10, "0")}#${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
}

/**
 * Copy per-call cost records out of a Pi session into the messaging table, so the cost API's drill-down survives the
 * session being dropped. Idempotent.
 *
 * @param client DynamoDB client.
 * @param tableName Messaging table.
 * @param tenantId Organization.
 * @param records The session's cost records.
 * @returns How many records were written.
 */
export async function copyCallCostsOut(
	client: DynamoDBClient,
	tableName: string,
	tenantId: string,
	records: readonly ModelCallCost[],
): Promise<number> {
	for (const record of records) {
		await client.send(
			new PutItemCommand({
				TableName: tableName,
				Item: {
					pk: { S: turnPartition(tenantId, record.turnId) },
					sk: { S: callCostCopySortKey(record) },
					tenant_id: { S: tenantId },
					turn_id: { S: record.turnId },
					record: { S: JSON.stringify(record) },
				},
			}),
		);
	}
	return records.length;
}

/**
 * The copied per-call cost records of one turn, oldest call first.
 *
 * @param client DynamoDB client.
 * @param tableName Messaging table.
 * @param tenantId Organization.
 * @param turnId Turn.
 * @returns The records; empty when none was copied.
 */
export async function readCopiedCallCosts(
	client: DynamoDBClient,
	tableName: string,
	tenantId: string,
	turnId: string,
): Promise<ModelCallCost[]> {
	const records: ModelCallCost[] = [];
	let startKey: Record<string, AttributeValue> | undefined;
	do {
		const page = await client.send(
			new QueryCommand({
				TableName: tableName,
				KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
				ExpressionAttributeValues: { ":pk": { S: turnPartition(tenantId, turnId) }, ":prefix": { S: CALL_COST_COPY_PREFIX } },
				ConsistentRead: true,
				ExclusiveStartKey: startKey,
			}),
		);
		for (const item of page.Items ?? []) records.push(JSON.parse(item.record!.S!) as ModelCallCost);
		startKey = page.LastEvaluatedKey;
	} while (startKey !== undefined);
	return records.sort((left, right) => left.entryId - right.entryId);
}

/** Where a session and the copy of its cost records live. */
export type SessionCallCostDependencies = {
	readonly client: DynamoDBClient;
	readonly s3: S3Client;
	readonly messagingTableName: string;
	readonly conversationsTableName: string;
	readonly bucket: string;
};

/**
 * Copy every per-call cost record a bot's session for a channel holds into the messaging table, reading the session
 * without owning or creating it. Run before the session is dropped, and once over every existing session when the copy
 * is introduced.
 *
 * @param deps Clients, tables and bucket.
 * @param tenantId Organization.
 * @param botId Bot.
 * @param channelId Channel.
 * @returns How many records were copied; zero when the session does not exist.
 */
export async function copySessionCallCosts(
	deps: SessionCallCostDependencies,
	tenantId: string,
	botId: string,
	channelId: string,
): Promise<number> {
	const storage = await IndexedStorage.openExisting({
		client: deps.client,
		s3: deps.s3,
		tableName: deps.conversationsTableName,
		bucket: deps.bucket,
		storageId: storageIdFor(tenantId, botId, channelId),
	});
	if (storage === undefined) return 0;
	try {
		const records = await readCallCostRecords(createSession(storage), storage, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
		return await copyCallCostsOut(deps.client, deps.messagingTableName, tenantId, records);
	} finally {
		await storage.close(BACKGROUND_CONTEXT);
	}
}
