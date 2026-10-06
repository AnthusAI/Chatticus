import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoBudgetStore } from "../budget/budget-store.ts";
import { DEFAULT_HEARTBEAT_TIMEOUT_SECONDS } from "../domain/workers.ts";
import { VendorPriceBook } from "../ledger/vendor-ledger.ts";
import { DynamoComputerActionStore } from "../store/action-store.ts";
import { DynamoMessagingStore } from "../store/dynamo-messaging-store.ts";
import { DynamoTurnControlStore } from "../store/turn-store.ts";
import { consumeRunJob } from "../turn/executor.ts";
import { createOpenAiModels, DEFAULT_TURN_MODEL } from "../turn/openai-models.ts";
import { SqsComputerStartQueue, SqsRunVisibility, SqsTurnProbeQueue, SqsTurnRunQueue } from "../turn/sqs-queues.ts";
import type { ExecutorDeps, TurnExecutionJob } from "../turn/types.ts";
import { resolveOpenAiApiKey } from "./openai-key.ts";

type SqsRecord = { readonly body: string; readonly receiptHandle: string };

/** The part of the Lambda context this handler reads. */
export type TurnRunsContext = { getRemainingTimeInMillis(): number };

/** The part of an SQS event this handler reads. */
export type TurnRunsEvent = { readonly Records: readonly SqsRecord[] };

const requiredEnvironment = (name: string): string => {
	const value = process.env[name];
	if (value === undefined || value === "") throw new Error(`The environment variable ${name} is required.`);
	return value;
};

type SharedDeps = Omit<ExecutorDeps, "runVisibility" | "remainingMilliseconds">;

let cachedDeps: SharedDeps | null = null;
let cachedRunsQueueUrl = "";
let cachedSqs: SQSClient | null = null;

async function executorDeps(): Promise<SharedDeps> {
	if (cachedDeps !== null) return cachedDeps;
	await resolveOpenAiApiKey();
	const client = new DynamoDBClient({});
	const sqs = new SQSClient({});
	cachedSqs = sqs;
	cachedRunsQueueUrl = requiredEnvironment("CHATTICUS_TURN_RUNS_QUEUE_URL");
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
		turnRuns: new SqsTurnRunQueue(sqs, cachedRunsQueueUrl),
		turnProbes: new SqsTurnProbeQueue(sqs, requiredEnvironment("CHATTICUS_TURN_PROBES_QUEUE_URL")),
		computer: {
			actions: new DynamoComputerActionStore(client, messagingTableName),
			computerStarts: new SqsComputerStartQueue(sqs, requiredEnvironment("CHATTICUS_COMPUTER_STARTS_QUEUE_URL")),
			rollups: new DynamoBudgetStore(client, messagingTableName),
			environment: requiredEnvironment("CHATTICUS_ENVIRONMENT"),
			heartbeatTimeoutSeconds: DEFAULT_HEARTBEAT_TIMEOUT_SECONDS,
		},
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
 * While a turn runs its lease renewals also extend the visibility of its message, and when the function is close to its
 * time limit the executor hands the turn on instead of running into it.
 *
 * @param event The SQS event.
 * @param context The Lambda context, for the remaining time.
 */
export async function handler(event: TurnRunsEvent, context: TurnRunsContext): Promise<void> {
	for (const record of event.Records) {
		const shared = await executorDeps();
		await consumeRunJob(
			jobFrom(record),
			{
				...shared,
				runVisibility: new SqsRunVisibility(cachedSqs!, cachedRunsQueueUrl, record.receiptHandle),
				remainingMilliseconds: () => context.getRemainingTimeInMillis(),
			},
			async () => undefined,
		);
	}
}
