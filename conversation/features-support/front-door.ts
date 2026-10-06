import type { IntegrationTestAuthConfig } from "../src/auth/integration-test.ts";
import type { SignupMode } from "../src/domain/signup-mode.ts";
import { createApp } from "../src/http/app.ts";
import { DEFAULT_STREAM_TIMING } from "../src/http/stream.ts";
import type { CommitObject } from "../src/storage/indexed-storage.ts";
import { MessageBodyCache } from "../src/pi/message-cache.ts";
import { DynamoWriteGate } from "../src/migration/migration-state.ts";
import { DynamoPolicyStore } from "../src/store/policy-store.ts";
import { DynamoTurnAdmission } from "../src/store/turn-admission-store.ts";
import { DynamoTurnControlStore } from "../src/store/turn-store.ts";
import { ApiClient } from "./api.ts";
import { ledgerDependenciesFor } from "./executor-harness.ts";
import { ensurePiStorage, type ScenarioPiStorage } from "./pi-storage.ts";
import { startAppServer } from "./http-server.ts";
import { probeQueueOf, runQueueOf, TURN_RUN_QUEUE } from "./turn-queues.ts";
import { CognitoTestKeys } from "./test-jwt.ts";
import type { ChatticusWorld } from "./world.ts";

/** The environment name a scenario's front door runs as, and so the budget environment its spend pause reads. */
export const DEFAULT_FRONT_DOOR_ENVIRONMENT = "test";

/** How one scenario's HTTP front door is wired. */
export type FrontDoorOptions = {
	signupMode: SignupMode;
	cognitoVerifier: boolean;
	organizationCreationRateLimit?: number;
	serveOverHttp?: boolean;
	environment?: string;
	invokeKey?: string | null;
	operatorKey?: string;
	integrationTest?: IntegrationTestAuthConfig | null;
	/** Serve write routes through the transcript migration write gate kept in the scenario's Messaging table. */
	migrationGate?: boolean;
	/** Wire the customer self-setup route to the scenario's in-memory role inspector instead of the live STS and IAM one. */
	inMemoryRoleInspector?: boolean;
};

/** The scenario's Cognito test keys, generated on first use. */
export async function cognitoKeys(world: ChatticusWorld): Promise<CognitoTestKeys> {
	if (world.cognitoTestKeys === null) {
		world.cognitoTestKeys = await CognitoTestKeys.generate();
	}
	return world.cognitoTestKeys;
}

export { TURN_RUN_QUEUE };

function messageDependencies(world: ChatticusWorld, piStorage: ScenarioPiStorage) {
	return {
		mailbox: { client: world.messagingTable.client, tableName: world.messagingTable.tableName },
		turns: new DynamoTurnAdmission(world.messagingTable.client, world.messagingTable.tableName),
		turnRuns: runQueueOf(world),
		turnProbes: probeQueueOf(world),
		faults: world.faultPlan,
		listing: {
			client: world.messagingTable.client,
			s3: piStorage.s3,
			messagingTableName: world.messagingTable.tableName,
			conversationsTableName: piStorage.tableName,
			bucket: piStorage.bucket,
			commitCache: new MessageBodyCache<Promise<CommitObject>>(),
		},
	};
}

/**
 * Build the production HTTP application over the scenario's messaging store
 * and point the scenario's API client at it.
 */
export async function wireFrontDoor(world: ChatticusWorld, options: FrontDoorOptions): Promise<void> {
	const keys = await cognitoKeys(world);
	world.frontDoorOptions = options;
	const app = createApp({
		clock: world.clock,
		ids: world.ids,
		store: world.messagingStore(),
		messages: messageDependencies(world, await ensurePiStorage(world)),
		voice: { understanding: world.scriptedUnderstanding, ledger: ledgerDependenciesFor(world) },
		turnControl: world.turnControlStore(),
		policy: new DynamoPolicyStore(world.messagingTable.client, world.messagingTable.tableName),
		budgetRollups: world.store,
		streamTiming: { ...DEFAULT_STREAM_TIMING, minimumPollMilliseconds: 5, maximumPollMilliseconds: 25 },
		streamClock: world.streamClock,
		openStreams: world.openStreams,
		invokeKey: options.invokeKey ?? null,
		writeGate: options.migrationGate === true ? new DynamoWriteGate(world.messagingTable.client, world.messagingTable.tableName) : undefined,
		operatorKey: options.operatorKey ?? "",
		integrationTest: options.integrationTest ?? null,
		environment: options.environment ?? DEFAULT_FRONT_DOOR_ENVIRONMENT,
		verifier: options.cognitoVerifier ? keys.verifier() : null,
		signupMode: options.signupMode,
		organizationCreationRateLimit: options.organizationCreationRateLimit,
		...(options.inMemoryRoleInspector === true ? { roleInspector: world.roleInspector } : {}),
	});
	world.app = app;
	world.api = new ApiClient(app);
	if (options.serveOverHttp || world.httpServer !== null) {
		if (world.httpServer !== null) {
			await world.httpServer.close();
		}
		world.httpServer = await startAppServer(app);
	}
	if (world.orgsByName === null) {
		world.orgsByName = new Map();
	}
	if (world.identitiesByEmail === null) {
		world.identitiesByEmail = new Map();
	}
}

/** The base URL of the scenario's HTTP application served on a loopback port, starting the server on first use. */
export async function httpBaseUrl(world: ChatticusWorld): Promise<string> {
	if (world.httpServer === null) {
		if (world.app === null) {
			throw new Error("The scenario has no HTTP front door.");
		}
		world.httpServer = await startAppServer(world.app);
	}
	return world.httpServer.baseUrl;
}

/** Authorization headers carrying a freshly minted valid id token for `email`. */
export async function bearerFor(world: ChatticusWorld, email: string): Promise<Record<string, string>> {
	const keys = await cognitoKeys(world);
	return { Authorization: `Bearer ${await keys.mintIdToken({ email })}` };
}

/** Open signup served over HTTP, with the web SPA pointed at it and holding a token for sam@example.com. */
export async function wireOpenSignupFrontDoorForWebSpa(world: ChatticusWorld): Promise<void> {
	await wireFrontDoor(world, { signupMode: "open", cognitoVerifier: true, serveOverHttp: true });
	if (world.httpServer === null) {
		throw new Error("The front door is not served over HTTP.");
	}
	world.webApiBase = world.httpServer.baseUrl;
	world.webIdToken = await (await cognitoKeys(world)).mintIdToken({ email: "sam@example.com" });
}
