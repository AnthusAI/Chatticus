import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoBudgetStore } from "../budget/budget-store.ts";
import { hostStarterFromEnvironment, hostStartDriverFor } from "../computer/host-starter.ts";
import { type ComputerStarterDependencies, type ComputerStartJob, handleComputerStartJob } from "../domain/computer-start.ts";
import { DEFAULT_HEARTBEAT_TIMEOUT_SECONDS } from "../domain/workers.ts";
import { DynamoComputerActionStore } from "../store/action-store.ts";
import { DynamoMessagingStore } from "../store/dynamo-messaging-store.ts";
import { DynamoTurnControlStore } from "../store/turn-store.ts";
import { resumeTurnForAction, type ParkDependencies } from "../turn/park.ts";
import { SqsComputerStartQueue, SqsTurnProbeQueue, SqsTurnRunQueue } from "../turn/sqs-queues.ts";

type SqsRecord = { readonly messageId: string; readonly body: string };

/** The part of an SQS event this handler reads. */
export type ComputerStartsEvent = { readonly Records: readonly SqsRecord[] };

/** What the handler reports: the messages that could not start a host and should be redelivered. */
export type ComputerStartsBatchResponse = { readonly batchItemFailures: { itemIdentifier: string }[] };

const requiredEnvironment = (name: string): string => {
	const value = process.env[name];
	if (value === undefined || value === "") throw new Error(`The environment variable ${name} is required.`);
	return value;
};

let cachedDependencies: ComputerStarterDependencies | null = null;

function starterDependencies(): ComputerStarterDependencies {
	if (cachedDependencies !== null) return cachedDependencies;
	const client = new DynamoDBClient({});
	const sqs = new SQSClient({});
	const tableName = requiredEnvironment("CHATTICUS_MESSAGING_TABLE");
	const environment = requiredEnvironment("CHATTICUS_ENVIRONMENT");
	const clock = { now: () => new Date() };
	const ids = { next: () => randomUUID() };
	const store = new DynamoMessagingStore(client, tableName);
	const actions = new DynamoComputerActionStore(client, tableName);
	const rollups = new DynamoBudgetStore(client, tableName);
	const park: ParkDependencies = {
		turns: { store: new DynamoTurnControlStore(client, tableName), clock, ids },
		messaging: store,
		turnRuns: new SqsTurnRunQueue(sqs, requiredEnvironment("CHATTICUS_TURN_RUNS_QUEUE_URL")),
		turnProbes: new SqsTurnProbeQueue(sqs, requiredEnvironment("CHATTICUS_TURN_PROBES_QUEUE_URL")),
		computer: {
			actions,
			computerStarts: new SqsComputerStartQueue(sqs, requiredEnvironment("CHATTICUS_COMPUTER_STARTS_QUEUE_URL")),
			rollups,
			environment,
			heartbeatTimeoutSeconds: DEFAULT_HEARTBEAT_TIMEOUT_SECONDS,
		},
	};
	cachedDependencies = {
		store,
		clock,
		ids,
		spend: { store, rollups, environment, clock },
		actions,
		driver: hostStartDriverFor(
			hostStarterFromEnvironment(async (tenantId) => {
				const organization = await store.getOrganization(tenantId);
				if (organization === null) throw new Error(`Organization ${JSON.stringify(tenantId)} does not exist.`);
				return organization;
			}),
		),
		resumeTurn: async (tenantId, turnId, actionId) => {
			await resumeTurnForAction(park, tenantId, turnId, actionId);
		},
	};
	return cachedDependencies;
}

function jobFrom(record: SqsRecord): ComputerStartJob {
	return JSON.parse(record.body) as ComputerStartJob;
}

/**
 * SQS entry point of the ComputerStarter Lambda. It starts the computer's host for each parked turn, once per host start
 * generation. A message that could not start a host (the driver failed or provisioning was refused) is reported as an
 * item failure so the queue redelivers only it; a refused spend ceiling is a finished job, not a failure.
 *
 * @param event The SQS event.
 * @returns The messages to redeliver.
 */
export async function handler(event: ComputerStartsEvent): Promise<ComputerStartsBatchResponse> {
	const batchItemFailures: { itemIdentifier: string }[] = [];
	for (const record of event.Records) {
		try {
			await handleComputerStartJob(starterDependencies(), jobFrom(record));
		} catch {
			batchItemFailures.push({ itemIdentifier: record.messageId });
		}
	}
	return { batchItemFailures };
}
