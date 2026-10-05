import type { SignupMode } from "../src/domain/signup-mode.ts";
import { createApp } from "../src/http/app.ts";
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
