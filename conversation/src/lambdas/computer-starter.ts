import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoBudgetStore } from "../budget/budget-store.ts";
import { hostStarterFromEnvironment, hostStartDriverFor, type EnvironmentHostStarterOptions } from "../computer/host-starter.ts";
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

/** The one Secrets Manager operation the starter uses; a real client or a fake satisfies it. */
export type StarterSecretReader = Pick<SecretsManagerClient, "send">;

/** The AWS clients the starter is composed from; tests inject fakes or emulator-backed clients. */
export type ComputerStarterAwsClients = {
	readonly dynamo: DynamoDBClient;
	readonly sqs: SQSClient;
	readonly secrets: StarterSecretReader;
};

/** The AWS clients a deployed starter uses, built from the Lambda's own role. */
export function defaultComputerStarterAwsClients(): ComputerStarterAwsClients {
	return { dynamo: new DynamoDBClient({}), sqs: new SQSClient({}), secrets: new SecretsManagerClient({}) };
}

async function readInvokeKey(secrets: StarterSecretReader, secretArn: string): Promise<string> {
	const response = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
	const value = response.SecretString ?? "";
	if (value === "") throw new Error(`The secret ${secretArn} has no value.`);
	return value;
}

let cachedDependencies: ComputerStarterDependencies | null = null;

/**
 * Build the starter from the environment: the stores, the queues and the host starter. The invoke key the host presents to
 * the Front Door is read from Secrets Manager by ARN and handed to the host starter in its own environment copy, so it is
 * forwarded in the RunTask overrides and never lives in the Lambda environment. Runs once per cold start.
 *
 * @param processEnvironment The environment variables; defaults to the process environment.
 * @param clients The AWS clients; defaults to real ones.
 * @param hostStarterOptions What replaces the real ECS and STS clients in the host starter, for tests.
 * @throws Error If a required environment variable is missing or the invoke key secret cannot be read or is empty.
 */
export async function composeComputerStarterDependencies(
	processEnvironment: Record<string, string | undefined> = process.env,
	clients: ComputerStarterAwsClients = defaultComputerStarterAwsClients(),
	hostStarterOptions: EnvironmentHostStarterOptions = {},
): Promise<ComputerStarterDependencies> {
	const requiredEnvironment = (name: string): string => {
		const value = processEnvironment[name];
		if (value === undefined || value === "") throw new Error(`The environment variable ${name} is required.`);
		return value;
	};
	const client = clients.dynamo;
	const sqs = clients.sqs;
	const tableName = requiredEnvironment("CHATTICUS_MESSAGING_TABLE");
	const environment = requiredEnvironment("CHATTICUS_ENVIRONMENT");
	requiredEnvironment("CHATTICUS_FRONT_DOOR_URL");
	const invokeKey = await readInvokeKey(clients.secrets, requiredEnvironment("CHATTICUS_INVOKE_KEY_SECRET_ARN"));
	const hostEnvironment = { ...processEnvironment, CHATTICUS_INVOKE_KEY: invokeKey };
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
	return {
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
			}, hostEnvironment, hostStarterOptions),
		),
		resumeTurn: async (tenantId, turnId, actionId) => {
			await resumeTurnForAction(park, tenantId, turnId, actionId);
		},
	};
}

async function starterDependencies(): Promise<ComputerStarterDependencies> {
	if (cachedDependencies === null) cachedDependencies = await composeComputerStarterDependencies();
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
			await handleComputerStartJob(await starterDependencies(), jobFrom(record));
		} catch (error) {
			console.error(`computer_start_failed message_id=${record.messageId} detail=${error instanceof Error ? error.message : String(error)}`);
			batchItemFailures.push({ itemIdentifier: record.messageId });
		}
	}
	return { batchItemFailures };
}
