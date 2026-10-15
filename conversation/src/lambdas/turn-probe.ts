import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import type { TurnProbeMessage } from "../domain/turn-admission.ts";
import { PiSubmissionInspector } from "../pi/submission-inspector.ts";
import { DynamoBudgetStore } from "../budget/budget-store.ts";
import { DEFAULT_HEARTBEAT_TIMEOUT_SECONDS } from "../domain/workers.ts";
import { DynamoComputerActionStore } from "../store/action-store.ts";
import { DynamoMessagingStore } from "../store/dynamo-messaging-store.ts";
import { DynamoTurnControlStore } from "../store/turn-store.ts";
import { handleProbe, type ProbeDependencies } from "../turn/probes.ts";
import { SqsComputerStartQueue, SqsTurnProbeQueue, SqsTurnRunQueue } from "../turn/sqs-queues.ts";

type SqsRecord = { readonly body: string };

/** The part of an SQS event this handler reads. */
export type TurnProbesEvent = { readonly Records: readonly SqsRecord[] };

const requiredEnvironment = (name: string): string => {
	const value = process.env[name];
	if (value === undefined || value === "") throw new Error(`The environment variable ${name} is required.`);
	return value;
};

let cachedDeps: ProbeDependencies | null = null;

function probeDependencies(): ProbeDependencies {
	if (cachedDeps !== null) return cachedDeps;
	const client = new DynamoDBClient({});
	const sqs = new SQSClient({});
	const messagingTableName = requiredEnvironment("CHATTICUS_MESSAGING_TABLE");
	cachedDeps = {
		turns: {
			store: new DynamoTurnControlStore(client, messagingTableName),
			clock: { now: () => new Date() },
			ids: { next: () => randomUUID() },
		},
		turnRuns: new SqsTurnRunQueue(sqs, requiredEnvironment("CHATTICUS_TURN_RUNS_QUEUE_URL")),
		turnProbes: new SqsTurnProbeQueue(sqs, requiredEnvironment("CHATTICUS_TURN_PROBES_QUEUE_URL")),
		messaging: new DynamoMessagingStore(client, messagingTableName),
		computer: {
			actions: new DynamoComputerActionStore(client, messagingTableName),
			computerStarts: new SqsComputerStartQueue(sqs, requiredEnvironment("CHATTICUS_COMPUTER_STARTS_QUEUE_URL")),
			rollups: new DynamoBudgetStore(client, messagingTableName),
			environment: requiredEnvironment("CHATTICUS_ENVIRONMENT"),
			heartbeatTimeoutSeconds: DEFAULT_HEARTBEAT_TIMEOUT_SECONDS,
		},
		submissions: new PiSubmissionInspector({
			client,
			s3: new S3Client({}),
			tableName: requiredEnvironment("CHATTICUS_CONVERSATIONS_TABLE"),
			bucket: requiredEnvironment("CHATTICUS_PI_SESSIONS_BUCKET"),
		}),
	};
	return cachedDeps;
}

function probeFrom(record: SqsRecord): TurnProbeMessage {
	const body = JSON.parse(record.body) as Record<string, unknown>;
	const { tenantId, turnId, kind, expectAttempt } = body;
	if (typeof tenantId !== "string" || typeof turnId !== "string" || kind !== "deadline" || typeof expectAttempt !== "number") {
		throw new Error("A TurnProbes message must name tenantId, turnId, kind deadline and expectAttempt.");
	}
	return { tenantId, turnId, kind, expectAttempt };
}

/**
 * SQS entry point of the TurnProbe Lambda, batch size 1. Each message is a delayed deadline probe that checks its own
 * turn; a failure propagates so the queue delivers the probe again.
 *
 * @param event The SQS event.
 */
export async function handler(event: TurnProbesEvent): Promise<void> {
	for (const record of event.Records) {
		await handleProbe(probeDependencies(), probeFrom(record));
	}
}
