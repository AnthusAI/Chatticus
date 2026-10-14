import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoBudgetStore } from "../../../conversation/src/budget/budget-store.ts";
import type { ComputerStartQueue } from "../../../conversation/src/domain/computer-start.ts";
import { DEFAULT_HEARTBEAT_TIMEOUT_SECONDS } from "../../../conversation/src/domain/workers.ts";
import { defaultVendorPriceBook } from "../../../conversation/src/ledger/vendor-prices.ts";
import { DynamoComputerActionStore } from "../../../conversation/src/store/action-store.ts";
import { DynamoMessagingStore } from "../../../conversation/src/store/dynamo-messaging-store.ts";
import { DynamoTurnControlStore } from "../../../conversation/src/store/turn-store.ts";
import { DEFAULT_TURN_MODEL } from "../../../conversation/src/turn/openai-models.ts";
import { NO_OP_RUN_VISIBILITY, NO_OP_TURN_PROBES, NO_OP_TURN_RUNS } from "../../../conversation/src/turn/in-process-queues.ts";
import type { ExecutorDeps, TurnExecutionJob } from "../../../conversation/src/turn/types.ts";
import type { LogEmitter } from "../../../conversation/src/observability/log-line.ts";
import { requiredPositiveIntegerSetting, requiredSetting } from "./owner-configuration.ts";
import { createGatewayModels, type ModelGatewayConfig } from "./owner-models.ts";
import type { StorageCredentialsProvider } from "./supervisor-ports.ts";

/** Where the container owner finds the session store and the model gateway. All of it is injected by the start of the computer. */
export type OwnerStoresConfig = {
	readonly messagingTableName: string;
	readonly conversationsTableName: string;
	readonly piSessionsBucket: string;
	/** The budget environment the spend ceiling reads. */
	readonly environment: string;
	readonly gateway: ModelGatewayConfig;
};

/**
 * Read the container owner's stores and gateway address from the environment the computer was started with. The environment
 * holds no credential: the gateway token comes from the provider the caller hands in, which asks the supervisor.
 *
 * @param environment The process environment.
 * @param gatewayToken Resolves the model gateway token each time a request to the gateway is sent.
 * @returns The typed configuration.
 * @throws OwnerConfigurationError If a required variable is missing.
 */
export function ownerStoresConfigFromEnvironment(environment: NodeJS.ProcessEnv, gatewayToken: () => Promise<string>): OwnerStoresConfig {
	return {
		messagingTableName: requiredSetting(environment, "CHATTICUS_MESSAGING_TABLE"),
		conversationsTableName: requiredSetting(environment, "CHATTICUS_CONVERSATIONS_TABLE"),
		piSessionsBucket: requiredSetting(environment, "CHATTICUS_PI_SESSIONS_BUCKET"),
		environment: requiredSetting(environment, "CHATTICUS_ENVIRONMENT"),
		gateway: {
			baseUrl: requiredSetting(environment, "CHATTICUS_MODEL_GATEWAY_URL"),
			tokenProvider: gatewayToken,
		},
	};
}

/**
 * The start queue of an owner that already runs on the computer: a turn that parks again (for a tool the owner cannot run
 * locally) has no computer to start, because this is the computer, so the job is accepted and dropped.
 */
export const NO_OP_COMPUTER_STARTS: ComputerStartQueue = {
	async enqueue(): Promise<void> {},
};

/**
 * The AWS clients of the container owner. Each is built with an explicit credentials provider and never with the default
 * chain, so a client whose supervisor holds no credentials fails the request instead of reading the process environment or
 * the instance metadata service.
 *
 * @param credentials Reads the credentials of the turn from the supervisor each time the SDK asks.
 * @returns The DynamoDB client and the S3 client.
 */
export function createOwnerAwsClients(credentials: StorageCredentialsProvider): { readonly dynamo: DynamoDBClient; readonly s3: S3Client } {
	return { dynamo: new DynamoDBClient({ credentials }), s3: new S3Client({ credentials }) };
}

/**
 * The executor's dependencies for the container owner: the real session stores through the credentials the supervisor
 * holds for the turn, the model gateway in place of the vendor, and queue pieces that publish nothing.
 *
 * @param config Stores and gateway.
 * @param credentials Reads the AWS credentials of the turn from the supervisor each time the SDK asks.
 * @param log Receives one `model_call` line for each request to the gateway; absent, none is written.
 * @returns The dependencies `takeOverTurn` runs with.
 */
export function createContainerOwnerDeps(config: OwnerStoresConfig, credentials: StorageCredentialsProvider, log?: LogEmitter): ExecutorDeps {
	const { dynamo: client, s3 } = createOwnerAwsClients(credentials);
	return {
		turns: { store: new DynamoTurnControlStore(client, config.messagingTableName), clock: { now: () => new Date() }, ids: { next: () => randomUUID() } },
		messaging: new DynamoMessagingStore(client, config.messagingTableName),
		client,
		s3,
		messagingTableName: config.messagingTableName,
		conversationsTableName: config.conversationsTableName,
		piSessionsBucket: config.piSessionsBucket,
		models: createGatewayModels(config.gateway, log),
		model: DEFAULT_TURN_MODEL,
		ledger: { client, tableName: config.messagingTableName, prices: defaultVendorPriceBook(), now: () => new Date() },
		ownerKind: "computer",
		workerLabel: "computer-host-owner",
		turnRuns: NO_OP_TURN_RUNS,
		turnProbes: NO_OP_TURN_PROBES,
		runVisibility: NO_OP_RUN_VISIBILITY,
		computer: {
			actions: new DynamoComputerActionStore(client, config.messagingTableName),
			computerStarts: NO_OP_COMPUTER_STARTS,
			rollups: new DynamoBudgetStore(client, config.messagingTableName),
			environment: config.environment,
			heartbeatTimeoutSeconds: DEFAULT_HEARTBEAT_TIMEOUT_SECONDS,
		},
	};
}

/** Who the per-turn container owner is: the organization and member of the dispatch, the owner id it claims under, and the host start generation of its supervisor. It holds no Front Door address and no host token. */
export type OwnerIdentityConfig = {
	readonly tenantId: string;
	readonly userId: string;
	/** The id the start generated; the gateway token is bound to it, and the owner claims the turn under it. */
	readonly ownerId: string;
	readonly generation: number;
};

/**
 * Read the per-turn owner's identity from the environment its supervisor built for it.
 *
 * @param environment The process environment.
 * @returns The typed identity.
 * @throws OwnerConfigurationError If a required variable is missing or the generation is not a positive integer.
 */
export function ownerIdentityFromEnvironment(environment: NodeJS.ProcessEnv = process.env): OwnerIdentityConfig {
	return {
		tenantId: requiredSetting(environment, "CHATTICUS_TENANT_ID"),
		userId: requiredSetting(environment, "CHATTICUS_USER_ID"),
		ownerId: requiredSetting(environment, "CHATTICUS_OWNER_ID"),
		generation: requiredPositiveIntegerSetting(environment, "CHATTICUS_OWNER_START_GENERATION"),
	};
}

/**
 * Read the turn the supervisor dispatched to this owner from the environment it built.
 *
 * @param environment The process environment.
 * @returns The takeover job and the dispatch id that delivered it.
 * @throws OwnerConfigurationError If a required variable is missing.
 */
export function ownerTurnJobFromEnvironment(environment: NodeJS.ProcessEnv = process.env): { readonly job: TurnExecutionJob; readonly dispatchId: string } {
	return {
		job: {
			tenantId: requiredSetting(environment, "CHATTICUS_TENANT_ID"),
			turnId: requiredSetting(environment, "CHATTICUS_TAKEOVER_TURN_ID"),
			botId: requiredSetting(environment, "CHATTICUS_TAKEOVER_BOT_ID"),
		},
		dispatchId: requiredSetting(environment, "CHATTICUS_DISPATCH_ID"),
	};
}

