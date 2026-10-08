import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoBudgetStore } from "../../../conversation/src/budget/budget-store.ts";
import type { ComputerStartQueue } from "../../../conversation/src/domain/computer-start.ts";
import { DEFAULT_HEARTBEAT_TIMEOUT_SECONDS } from "../../../conversation/src/domain/workers.ts";
import { VendorPriceBook } from "../../../conversation/src/ledger/vendor-ledger.ts";
import { DynamoComputerActionStore } from "../../../conversation/src/store/action-store.ts";
import { DynamoMessagingStore } from "../../../conversation/src/store/dynamo-messaging-store.ts";
import { DynamoTurnControlStore } from "../../../conversation/src/store/turn-store.ts";
import { DEFAULT_TURN_MODEL } from "../../../conversation/src/turn/openai-models.ts";
import { NO_OP_RUN_VISIBILITY, NO_OP_TURN_PROBES, NO_OP_TURN_RUNS } from "../../../conversation/src/turn/in-process-queues.ts";
import type { ExecutorDeps } from "../../../conversation/src/turn/types.ts";
import { createGatewayModels, type ModelGatewayConfig } from "./owner-models.ts";

/** A required setting of the container owner is missing. */
export class OwnerConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OwnerConfigurationError";
	}
}

/** Where the container owner finds the session store and the model gateway. All of it is injected by the start of the computer. */
export type OwnerStoresConfig = {
	readonly messagingTableName: string;
	readonly conversationsTableName: string;
	readonly piSessionsBucket: string;
	/** The budget environment the spend ceiling reads. */
	readonly environment: string;
	readonly gateway: ModelGatewayConfig;
};

const requiredSetting = (environment: NodeJS.ProcessEnv, name: string): string => {
	const value = (environment[name] ?? "").trim();
	if (value === "") throw new OwnerConfigurationError(`The environment variable ${name} is required.`);
	return value;
};

/**
 * Read the container owner's stores and gateway from the environment the computer was started with.
 *
 * @param environment The process environment.
 * @returns The typed configuration.
 * @throws OwnerConfigurationError If a required variable is missing.
 */
export function ownerStoresConfigFromEnvironment(environment: NodeJS.ProcessEnv = process.env): OwnerStoresConfig {
	return {
		messagingTableName: requiredSetting(environment, "CHATTICUS_MESSAGING_TABLE"),
		conversationsTableName: requiredSetting(environment, "CHATTICUS_CONVERSATIONS_TABLE"),
		piSessionsBucket: requiredSetting(environment, "CHATTICUS_PI_SESSIONS_BUCKET"),
		environment: requiredSetting(environment, "CHATTICUS_ENVIRONMENT"),
		gateway: {
			baseUrl: requiredSetting(environment, "CHATTICUS_MODEL_GATEWAY_URL"),
			token: requiredSetting(environment, "CHATTICUS_MODEL_GATEWAY_TOKEN"),
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
 * The executor's dependencies for the container owner: the real session stores through the credentials the container was
 * given, the model gateway in place of the vendor, and queue pieces that publish nothing.
 *
 * @param config Stores and gateway.
 * @returns The dependencies `takeOverTurn` runs with.
 */
export function createContainerOwnerDeps(config: OwnerStoresConfig): ExecutorDeps {
	const client = new DynamoDBClient({});
	return {
		turns: { store: new DynamoTurnControlStore(client, config.messagingTableName), clock: { now: () => new Date() }, ids: { next: () => randomUUID() } },
		messaging: new DynamoMessagingStore(client, config.messagingTableName),
		client,
		s3: new S3Client({}),
		messagingTableName: config.messagingTableName,
		conversationsTableName: config.conversationsTableName,
		piSessionsBucket: config.piSessionsBucket,
		models: createGatewayModels(config.gateway),
		model: DEFAULT_TURN_MODEL,
		ledger: { client, tableName: config.messagingTableName, prices: new VendorPriceBook(), now: () => new Date() },
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
