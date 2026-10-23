import { randomUUID } from "node:crypto";
import { CachedFailClosedWriteGate, DynamoWriteGate } from "../migration/migration-state.ts";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { SQSClient } from "@aws-sdk/client-sqs";
import type { Hono } from "hono";
import { botBoardServiceFromEnvironment } from "../board/bot-board-service-factory.ts";
import { createIdTokenVerifier } from "../auth/cognito.ts";
import { secretsManagerInvokeKeySource } from "../auth/invoke-key-source.ts";
import { loadIntegrationTestAuthConfig, seedIntegrationTestOrganization } from "../auth/integration-test.ts";
import { OrganizationSeedConflictError } from "../domain/organizations.ts";
import { DynamoBudgetStore } from "../budget/budget-store.ts";
import { DEFAULT_HEARTBEAT_TIMEOUT_SECONDS } from "../domain/workers.ts";
import { parseSignupMode } from "../domain/signup-mode.ts";
import { createApp } from "../http/app.ts";
import { LambdaOwnerCredentialBroker, OWNER_CREDENTIAL_BROKER_FUNCTION_NAME_VARIABLE } from "../computer/lambda-owner-credential-broker.ts";
import type { ModelGatewayDependencies } from "../gateway/model-gateway.ts";
import { defaultVendorPriceBook } from "../ledger/vendor-prices.ts";
import { MessageBodyCache } from "../pi/message-cache.ts";
import { SnapshotFileService } from "../snapshot/files.ts";
import { S3SnapshotStore } from "../snapshot/s3.ts";
import { S3OverlayStore } from "../snapshot/overlay-store.ts";
import { StoreOverlayAuditSink } from "../domain/file-audit.ts";
import type { CommitObject } from "../storage/indexed-storage.ts";
import { DynamoComputerActionStore } from "../store/action-store.ts";
import { DynamoMessagingStore } from "../store/dynamo-messaging-store.ts";
import { DynamoPolicyStore } from "../store/policy-store.ts";
import { DynamoTurnAdmission } from "../store/turn-admission-store.ts";
import { DynamoTurnControlStore } from "../store/turn-store.ts";
import { DynamoGatewayObservationSink } from "../ledger/gateway-observation.ts";
import { DynamoModelSpendReader, monthlyModelSpendCeilingUsdFrom } from "../ledger/model-spend.ts";
import { createOpenAiModels } from "../turn/openai-models.ts";
import { SqsComputerStartQueue, SqsTurnProbeQueue, SqsTurnRunQueue } from "../turn/sqs-queues.ts";
import { ModelUserUnderstanding } from "../voice/understanding.ts";
import { resolveOpenAiApiKey, type ParameterReader } from "./openai-key.ts";

/** The AWS clients the front door is composed from; tests inject fakes or emulator-backed clients. */
export type FrontDoorAwsClients = {
	readonly dynamo: DynamoDBClient;
	readonly s3: S3Client;
	readonly sqs: SQSClient;
	readonly parameters: ParameterReader;
	readonly secrets: SecretReader;
	/** Invokes the credential broker; built from the Lambda's own role when absent. */
	readonly lambda?: Pick<LambdaClient, "send">;
};

/** The one Secrets Manager operation the front door uses; a real client or a fake satisfies it. */
export type SecretReader = Pick<SecretsManagerClient, "send">;

/** The AWS clients a deployed front door uses, built from the Lambda's own role. */
export function defaultFrontDoorAwsClients(): FrontDoorAwsClients {
	return { dynamo: new DynamoDBClient({}), s3: new S3Client({}), sqs: new SQSClient({}),
		parameters: new SSMClient({}),
		secrets: new SecretsManagerClient({}),
	};
}

/**
 * Every environment variable the front door reads, by name. A missing or empty one fails composition with a message that
 * names it.
 */
export const REQUIRED_FRONT_DOOR_ENVIRONMENT = [
	"CHATTICUS_ENVIRONMENT",
	"CHATTICUS_MESSAGING_TABLE",
	"CHATTICUS_CONVERSATIONS_TABLE",
	"CHATTICUS_PI_SESSIONS_BUCKET",
	"CHATTICUS_TURN_RUNS_QUEUE_URL",
	"CHATTICUS_TURN_PROBES_QUEUE_URL",
	"CHATTICUS_COMPUTER_STARTS_QUEUE_URL",
	"CHATTICUS_SIGNUP_MODE",
	"CHATTICUS_COGNITO_USER_POOL_ID_PARAMETER",
	"CHATTICUS_COGNITO_APP_CLIENT_ID_PARAMETER",
	"CHATTICUS_INVOKE_KEY_SECRET_ARN",
	"CHATTICUS_OPERATOR_KEY_PARAMETER_NAME",
] as const;

/** Names the SSM SecureString parameter holding the model gateway's session token signing key. The gateway is mounted only when it is set. */
export const MODEL_GATEWAY_SIGNING_KEY_PARAMETER_NAME_VARIABLE = "CHATTICUS_MODEL_GATEWAY_SIGNING_KEY_PARAMETER_NAME";

/** Names the snapshot bucket the read-only file routes read. The routes answer 503 while it is unset. */
export const SNAPSHOT_BUCKET_VARIABLE = "CHATTICUS_SNAPSHOT_BUCKET";

/** The vendor address the gateway forwards to unless `CHATTICUS_MODEL_GATEWAY_UPSTREAM_URL` names another. */
export const DEFAULT_MODEL_GATEWAY_UPSTREAM_URL = "https://api.openai.com/v1";

const requiredIn = (environment: Record<string, string | undefined>, name: string): string => {
	const value = environment[name];
	if (value === undefined || value === "") throw new Error(`The environment variable ${name} is required.`);
	return value;
};

async function readParameter(parameters: ParameterReader, name: string): Promise<string> {
	const response = await parameters.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
	return response.Parameter?.Value ?? "";
}

async function optionalParameter(parameters: ParameterReader, name: string): Promise<string> {
	try {
		return await readParameter(parameters, name);
	} catch (error) {
		if (error instanceof Error && error.name === "ParameterNotFound") return "";
		throw error;
	}
}

async function requiredParameter(parameters: ParameterReader, name: string): Promise<string> {
	const value = await readParameter(parameters, name);
	if (value === "") throw new Error(`The SSM parameter ${name} has no value.`);
	return value;
}

const DEPLOYMENT_AWS_ACCOUNT_ID_PATTERN = /^\d{12}$/;

function deploymentAwsAccountIdFrom(environment: Record<string, string | undefined>): string {
	const accountId = requiredIn(environment, "CHATTICUS_DEPLOYMENT_AWS_ACCOUNT_ID");
	if (!DEPLOYMENT_AWS_ACCOUNT_ID_PATTERN.test(accountId)) {
		throw new Error("The environment variable CHATTICUS_DEPLOYMENT_AWS_ACCOUNT_ID must be a twelve-digit AWS account id.");
	}
	return accountId;
}

/**
 * Seed the integration-test organization and its member. Seeding converges on the same records, so a second or a
 * concurrent cold start is harmless; a concurrent start that sees the organization before its membership lands retries
 * once. Any other failure fails the cold start.
 */
async function seedIntegrationTestOrganizationOnce(
	dependencies: Parameters<typeof seedIntegrationTestOrganization>[0],
	tenantId: string,
	userId: string,
): Promise<void> {
	try {
		await seedIntegrationTestOrganization(dependencies, { tenantId, userId });
	} catch (error) {
		if (!(error instanceof OrganizationSeedConflictError)) throw error;
		await new Promise((resolve) => setTimeout(resolve, 250));
		await seedIntegrationTestOrganization(dependencies, { tenantId, userId });
	}
}

/**
 * Build the real HTTP application from the environment: the Dynamo stores, the three SQS queues, the OpenAI voice
 * understanding, the Cognito id token verifier, the invoke keys (read from Secrets Manager by ARN), the operator key and the gateway signing key (read from SSM SecureString parameters by name), and (outside production) the integration
 * test session exchange. Runs once per cold start.
 *
 * @param environment The environment variables; defaults to the process environment.
 * @param clients The AWS clients; defaults to real ones.
 * @throws Error If a required environment variable or SSM parameter is missing or empty.
 */
export async function composeFrontDoorApp(
	environment: Record<string, string | undefined> = process.env,
	clients: FrontDoorAwsClients = defaultFrontDoorAwsClients(),
	clock: { now(): Date } = { now: () => new Date() },
): Promise<Hono> {
	for (const name of REQUIRED_FRONT_DOOR_ENVIRONMENT) requiredIn(environment, name);
	const environmentName = requiredIn(environment, "CHATTICUS_ENVIRONMENT");
	const messagingTableName = requiredIn(environment, "CHATTICUS_MESSAGING_TABLE");
	const invokeKeys = await secretsManagerInvokeKeySource(
		clients.secrets,
		requiredIn(environment, "CHATTICUS_INVOKE_KEY_SECRET_ARN"),
		clock,
	);
	const [invokeKey = ""] = await invokeKeys();
	const operatorKey = await requiredParameter(clients.parameters, requiredIn(environment, "CHATTICUS_OPERATOR_KEY_PARAMETER_NAME"));
	const deploymentAwsAccountId = deploymentAwsAccountIdFrom(environment);
	await resolveOpenAiApiKey(environment, clients.parameters);
	const userPoolId = await requiredParameter(clients.parameters, requiredIn(environment, "CHATTICUS_COGNITO_USER_POOL_ID_PARAMETER"));
	const clientId = await requiredParameter(clients.parameters, requiredIn(environment, "CHATTICUS_COGNITO_APP_CLIENT_ID_PARAMETER"));
	const integrationTest = await loadIntegrationTestAuthConfig({
		environment: environmentName,
		invokeKey,
		environmentVariables: environment,
		readParameter: (name) => optionalParameter(clients.parameters, name),
	});
	const client = clients.dynamo;
	const prices = defaultVendorPriceBook();
	const ids = { next: () => randomUUID() };
	const store = new DynamoMessagingStore(client, messagingTableName);
	if (integrationTest !== null) {
		await seedIntegrationTestOrganizationOnce(
			{ store, clock, ids, callerAwsAccountId: async () => deploymentAwsAccountId },
			integrationTest.tenantId,
			integrationTest.userId,
		);
	}
	const gatewayParameterName = environment[MODEL_GATEWAY_SIGNING_KEY_PARAMETER_NAME_VARIABLE] ?? "";
	const gatewaySigningKey = gatewayParameterName === "" ? "" : await requiredParameter(clients.parameters, gatewayParameterName);
	const brokerFunctionName = environment[OWNER_CREDENTIAL_BROKER_FUNCTION_NAME_VARIABLE] ?? "";
	const ownerSupervisor =
		gatewaySigningKey === "" || brokerFunctionName === ""
			? undefined
			: { signingKey: gatewaySigningKey, broker: new LambdaOwnerCredentialBroker(clients.lambda ?? new LambdaClient({}), brokerFunctionName) };
	const modelGateway: ModelGatewayDependencies | undefined =
		gatewayParameterName === ""
			? undefined
			: {
					signingKey: gatewaySigningKey,
					clock,
					turns: new DynamoTurnControlStore(client, messagingTableName),
					upstream: {
						baseUrl: environment["CHATTICUS_MODEL_GATEWAY_UPSTREAM_URL"] || DEFAULT_MODEL_GATEWAY_UPSTREAM_URL,
						apiKey: requiredIn(environment, "OPENAI_API_KEY"),
						fetch: (input, init) => fetch(input, init),
					},
					log: (event) => console.log(JSON.stringify({ component: "model-gateway", ...event })),
					observations: new DynamoGatewayObservationSink({ client, tableName: messagingTableName }),
					modelSpend: new DynamoModelSpendReader({ client, tableName: messagingTableName }),
					monthlyModelSpendCeilingUsd: monthlyModelSpendCeilingUsdFrom(environment),
				};
	const snapshotBucket = environment[SNAPSHOT_BUCKET_VARIABLE] ?? "";
	const boards = botBoardServiceFromEnvironment(environment, { credentials: () => client.config.credentials(), memberships: store, bots: store });
	return createApp({
		boards,
		snapshotFiles: snapshotBucket === "" ? null : new SnapshotFileService(new S3SnapshotStore(snapshotBucket, clients.s3)),
		editOverlay:
			snapshotBucket === ""
				? null
				: { overlay: new S3OverlayStore(snapshotBucket, clients.s3), snapshots: new S3SnapshotStore(snapshotBucket, clients.s3), audit: new StoreOverlayAuditSink(store) },
		modelGateway,
		ownerSupervisor,
		writeGate: new CachedFailClosedWriteGate(new DynamoWriteGate(client, messagingTableName), clock),
		clock,
		ids,
		store,
		messages: {
			mailbox: { client, tableName: messagingTableName },
			turns: new DynamoTurnAdmission(client, messagingTableName),
			turnRuns: new SqsTurnRunQueue(clients.sqs, requiredIn(environment, "CHATTICUS_TURN_RUNS_QUEUE_URL")),
			turnProbes: new SqsTurnProbeQueue(clients.sqs, requiredIn(environment, "CHATTICUS_TURN_PROBES_QUEUE_URL")),
			listing: {
				client,
				s3: clients.s3,
				messagingTableName,
				conversationsTableName: requiredIn(environment, "CHATTICUS_CONVERSATIONS_TABLE"),
				bucket: requiredIn(environment, "CHATTICUS_PI_SESSIONS_BUCKET"),
				commitCache: new MessageBodyCache<Promise<CommitObject>>(),
			},
		},
		voice: {
			understanding: new ModelUserUnderstanding(createOpenAiModels()),
			ledger: { client, tableName: messagingTableName, prices, now: () => new Date() },
		},
		turnControl: new DynamoTurnControlStore(client, messagingTableName),
		policy: new DynamoPolicyStore(client, messagingTableName),
		computer: {
			actions: new DynamoComputerActionStore(client, messagingTableName),
			computerStarts: new SqsComputerStartQueue(clients.sqs, requiredIn(environment, "CHATTICUS_COMPUTER_STARTS_QUEUE_URL")),
			rollups: new DynamoBudgetStore(client, messagingTableName),
			environment: environmentName,
			heartbeatTimeoutSeconds: DEFAULT_HEARTBEAT_TIMEOUT_SECONDS,
		},
		budgetRollups: new DynamoBudgetStore(client, messagingTableName),
		invokeKeys,
		operatorKey,
		deploymentAwsAccountId,
		integrationTest,
		environment: environmentName,
		verifier: createIdTokenVerifier({ userPoolId, clientId }),
		signupMode: parseSignupMode(requiredIn(environment, "CHATTICUS_SIGNUP_MODE")),
	});
}
