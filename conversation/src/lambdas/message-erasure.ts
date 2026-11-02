import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { completePendingErasures, type ErasureDependencies, eraseMessage } from "../domain/message-erasure.ts";
import { DynamoMessagingStore } from "../store/dynamo-messaging-store.ts";
import { DynamoTurnAdmission } from "../store/turn-admission-store.ts";
import { composeChannelListing, requiredVariable } from "./message-dependencies.ts";

/** An SQS record of the erasure queue, or no record at all for the scheduled sweep. */
export type MessageErasureEvent = { readonly Records?: ReadonlyArray<{ readonly body: string }> };

let cachedDeps: ErasureDependencies | null = null;

function erasureDependencies(): ErasureDependencies {
	if (cachedDeps !== null) return cachedDeps;
	const dynamo = new DynamoDBClient({});
	const s3 = new S3Client({});
	const messagingTableName = requiredVariable(process.env, "CHATTICUS_MESSAGING_TABLE");
	cachedDeps = {
		store: new DynamoMessagingStore(dynamo, messagingTableName),
		clock: { now: () => new Date() },
		mailbox: { client: dynamo, tableName: messagingTableName },
		turns: new DynamoTurnAdmission(dynamo, messagingTableName),
		listing: composeChannelListing(process.env, { dynamo, s3 }, messagingTableName),
	};
	return cachedDeps;
}

type ErasureRequest =
	| { readonly type: "erase"; readonly tenantId: string; readonly channelId: string; readonly seq: number }
	| { readonly type: "complete"; readonly tenantId: string; readonly channelId: string };

function requestFrom(body: string): ErasureRequest {
	const parsed = JSON.parse(body) as Record<string, unknown>;
	const { type, tenantId, channelId, seq } = parsed;
	if (typeof tenantId !== "string" || typeof channelId !== "string") throw new Error("An erasure message must name tenantId and channelId.");
	if (type === "erase" && typeof seq === "number") return { type, tenantId, channelId, seq };
	if (type === "complete") return { type, tenantId, channelId };
	throw new Error("An erasure message must be type erase with a seq, or type complete.");
}

/**
 * Entry point of the MessageErasure Lambda. An SQS message either erases one message or finishes the erasures of one
 * channel that waited for a turn; the scheduled event (no records) finishes every pending erasure. A failure propagates,
 * so the queue delivers the message again and the schedule tries on its next tick. Every step is safe to repeat.
 *
 * @param event The SQS event, or the scheduled event.
 */
export async function handler(event: MessageErasureEvent): Promise<void> {
	const deps = erasureDependencies();
	if (event.Records === undefined) {
		await completePendingErasures(deps);
		return;
	}
	for (const record of event.Records) {
		const request = requestFrom(record.body);
		if (request.type === "erase") await eraseMessage(deps, request);
		else await completePendingErasures(deps, request);
	}
}
