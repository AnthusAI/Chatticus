import { S3Client } from "@aws-sdk/client-s3";
import type { SignupMode } from "../src/domain/signup-mode.ts";
import type { TurnRunJob } from "../src/domain/turn-admission.ts";
import { createApp } from "../src/http/app.ts";
import type { CommitObject } from "../src/storage/indexed-storage.ts";
import { MessageBodyCache } from "../src/pi/message-cache.ts";
import { DynamoTurnAdmission } from "../src/store/turn-admission-store.ts";
import { DynamoTurnControlStore } from "../src/store/turn-store.ts";
import { ApiClient } from "./api.ts";
import { startAppServer } from "./http-server.ts";
import { CognitoTestKeys } from "./test-jwt.ts";
import type { ChatticusWorld } from "./world.ts";

/** How one scenario's HTTP front door is wired. */
export type FrontDoorOptions = {
	signupMode: SignupMode;
	cognitoVerifier: boolean;
	organizationCreationRateLimit?: number;
	serveOverHttp?: boolean;
	environment?: string;
};

/** The scenario's Cognito test keys, generated on first use. */
export async function cognitoKeys(world: ChatticusWorld): Promise<CognitoTestKeys> {
	if (world.cognitoTestKeys === null) {
		world.cognitoTestKeys = await CognitoTestKeys.generate();
	}
	return world.cognitoTestKeys;
}

/** The queue name run jobs for new turns are recorded under in the scenario's queue recorder. */
export const TURN_RUN_QUEUE = "turn-runs";

const CONVERSATIONS_TABLE_NAME = "Conversations";
const PI_SESSIONS_BUCKET_NAME = "PiSessions";

function messageDependencies(world: ChatticusWorld) {
	const s3 = new S3Client({
		endpoint: process.env.CHATTICUS_TEST_AWS_ENDPOINT ?? "http://127.0.0.1:5555",
		region: "us-east-1",
		credentials: { accessKeyId: "test", secretAccessKey: "test" },
		forcePathStyle: true,
		maxAttempts: 1,
	});
	return {
		mailbox: { client: world.messagingTable.client, tableName: world.messagingTable.tableName },
		turns: new DynamoTurnAdmission(world.messagingTable.client, world.messagingTable.tableName),
		turnRuns: {
			async enqueue(job: TurnRunJob): Promise<void> {
				world.queues.send(TURN_RUN_QUEUE, job);
			},
		},
		listing: {
			client: world.messagingTable.client,
			s3,
			messagingTableName: world.messagingTable.tableName,
			conversationsTableName: CONVERSATIONS_TABLE_NAME,
			bucket: PI_SESSIONS_BUCKET_NAME,
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
	const app = createApp({
		clock: world.clock,
		ids: world.ids,
		store: world.messagingStore(),
		messages: messageDependencies(world),
		turnControl: world.turnControlStore(),
		invokeKey: null,
		environment: options.environment ?? "test",
		verifier: options.cognitoVerifier ? keys.verifier() : null,
		signupMode: options.signupMode,
		organizationCreationRateLimit: options.organizationCreationRateLimit,
	});
	world.api = new ApiClient(app);
	if (options.serveOverHttp) {
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
