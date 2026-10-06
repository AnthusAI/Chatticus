import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { VendorPriceBook } from "../ledger/vendor-ledger.ts";
import { DynamoMessagingStore } from "../store/dynamo-messaging-store.ts";
import { DynamoTurnControlStore } from "../store/turn-store.ts";
import { executeTurn } from "../turn/executor.ts";
import { createOpenAiModels, DEFAULT_TURN_MODEL } from "../turn/openai-models.ts";
import type { ExecutorDeps, TurnExecutionJob } from "../turn/types.ts";

type SqsRecord = { readonly body: string };

/** The part of an SQS event this handler reads. */
export type TurnRunsEvent = { readonly Records: readonly SqsRecord[] };

const requiredEnvironment = (name: string): string => {
	const value = process.env[name];
	if (value === undefined || value === "") throw new Error(`The environment variable ${name} is required.`);
	return value;
};

let cachedDeps: ExecutorDeps | null = null;

function executorDeps(): ExecutorDeps {
	if (cachedDeps !== null) return cachedDeps;
	const client = new DynamoDBClient({});
	const messagingTableName = requiredEnvironment("CHATTICUS_MESSAGING_TABLE");
	cachedDeps = {
		turns: {
			store: new DynamoTurnControlStore(client, messagingTableName),
			clock: { now: () => new Date() },
			ids: { next: () => randomUUID() },
		},
		messaging: new DynamoMessagingStore(client, messagingTableName),
		client,
		s3: new S3Client({}),
		messagingTableName,
		conversationsTableName: requiredEnvironment("CHATTICUS_CONVERSATIONS_TABLE"),
		piSessionsBucket: requiredEnvironment("CHATTICUS_PI_SESSIONS_BUCKET"),
		models: createOpenAiModels(),
		model: DEFAULT_TURN_MODEL,
		ledger: { client, tableName: messagingTableName, prices: new VendorPriceBook(), now: () => new Date() },
		workerLabel: "turn-executor-lambda",
	};
	return cachedDeps;
}

function jobFrom(record: SqsRecord): TurnExecutionJob {
	const body = JSON.parse(record.body) as Record<string, unknown>;
	const { tenantId, turnId, botId } = body;
	if (typeof tenantId !== "string" || typeof turnId !== "string" || typeof botId !== "string") {
		throw new Error("A TurnRuns message must name tenantId, turnId and botId.");
	}
	return { tenantId, turnId, botId };
}

/**
 * SQS entry point of the TurnExecutor Lambda, batch size 1. A turn that ends (done, failed, lost, or handed to
 * reconciliation) acknowledges its message; an infrastructure error propagates so the queue redelivers the job.
 *
 * @param event The SQS event.
 */
export async function handler(event: TurnRunsEvent): Promise<void> {
	for (const record of event.Records) {
		await executeTurn(jobFrom(record), executorDeps());
	}
}
