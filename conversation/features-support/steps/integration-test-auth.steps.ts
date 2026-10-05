import assert from "node:assert/strict";
import { Given, Then, When, type DataTable } from "@cucumber/cucumber";
import {
	INTEGRATION_TEST_SESSION_PATH,
	loadIntegrationTestAuthConfig,
	mintIntegrationTestToken,
	mintIntegrationTestTokenExpired,
	seedIntegrationTestOrganization,
	type CallerVerifier,
	type IntegrationTestAuthConfig,
} from "../../src/auth/integration-test.ts";
import { recordResponse, type RecordedResponse } from "../api.ts";
import { wireFrontDoor } from "../front-door.ts";
import type { ChatticusWorld } from "../world.ts";
import { registerWorkerOverHttp } from "./worker-registration.ts";

const ROLE_HEADER = "X-Chatticus-Integration-Test-Role";
const INTEGRATION_TEST_INVOKE_KEY = "integration-test-key";
const FRONT_DOOR_INVOKE_HEADER = "X-Chatticus-Invoke-Key";

/** State of one integration-test scenario: configuration, the bearer under test, bots made, last responses. */
export type IntegrationTestScenarioState = {
	environment: string;
	allowedRoleArn: string;
	tenantId: string;
	userId: string;
	config: IntegrationTestAuthConfig | null;
	bearer: string;
	botsByName: Map<string, { bot_id: string }>;
	channel: { channel_id: string } | null;
	sessionResponse: RecordedResponse | null;
	channelResponse: RecordedResponse | null;
	postResponse: RecordedResponse | null;
	workerRouteResponse: RecordedResponse | null;
};

const callerVerifierFromRoleHeader: CallerVerifier = async (request) => {
	const role = (request.headers.get(ROLE_HEADER) ?? "").trim();
	return role === "" ? null : role;
};

function scenario(world: ChatticusWorld): IntegrationTestScenarioState {
	if (world.integrationTestScenario === null) {
		throw new Error("Integration test auth is not enabled in this scenario.");
	}
	return world.integrationTestScenario;
}

function configuration(world: ChatticusWorld): IntegrationTestAuthConfig {
	const config = scenario(world).config;
	assert.ok(config, "integration test auth is not configured");
	return config;
}

function frontDoorHeaders(): Record<string, string> {
	return { [FRONT_DOOR_INVOKE_HEADER]: INTEGRATION_TEST_INVOKE_KEY };
}

function bearerHeaders(world: ChatticusWorld): Record<string, string> {
	const token = scenario(world).bearer;
	assert.ok(token, "integration test bearer token is missing");
	return { ...frontDoorHeaders(), Authorization: `Bearer ${token}` };
}

async function wireIntegrationTestFrontDoor(
	world: ChatticusWorld,
	config: IntegrationTestAuthConfig | null,
): Promise<void> {
	await wireFrontDoor(world, {
		signupMode: "invitation_only",
		cognitoVerifier: true,
		environment: scenario(world).environment,
		invokeKey: INTEGRATION_TEST_INVOKE_KEY,
		integrationTest: config,
	});
}

async function ensureBot(world: ChatticusWorld, botName: string): Promise<RecordedResponse | null> {
	const state = scenario(world);
	assert.ok(world.api, "The scenario has no HTTP front door.");
	if (state.botsByName.has(botName)) {
		return null;
	}
	const response = await recordResponse(
		await world.api.post(`/orgs/${state.tenantId}/bots`, { headers: bearerHeaders(world), body: { name: botName } }),
	);
	if (response.status === 200) {
		state.botsByName.set(botName, response.json);
	}
	return response.status === 200 ? null : response;
}

async function createChannelFor(world: ChatticusWorld, userId: string, botName: string): Promise<void> {
	const state = scenario(world);
	assert.ok(world.api, "The scenario has no HTTP front door.");
	const botFailure = await ensureBot(world, botName);
	if (botFailure !== null) {
		state.channelResponse = botFailure;
		return;
	}
	const bot = state.botsByName.get(botName);
	assert.ok(bot);
	state.channelResponse = await recordResponse(
		await world.api.post(`/orgs/${state.tenantId}/channels`, {
			headers: bearerHeaders(world),
			body: { user_id: userId, bot_ids: [bot.bot_id], kind: "direct", name: null },
		}),
	);
	if (state.channelResponse.status === 200) {
		state.channel = state.channelResponse.json;
	}
}

Given("integration test auth is enabled for environment {string}", function (this: ChatticusWorld, environment: string) {
	const previous = this.integrationTestScenario;
	this.integrationTestScenario = {
		environment,
		allowedRoleArn: previous?.allowedRoleArn ?? "",
		tenantId: previous?.tenantId ?? "",
		userId: previous?.userId ?? "",
		config: previous?.config ?? null,
		bearer: "",
		botsByName: new Map(),
		channel: null,
		sessionResponse: null,
		channelResponse: null,
		postResponse: null,
		workerRouteResponse: null,
	};
});

Given("integration test auth allows role {string}", function (this: ChatticusWorld, roleArn: string) {
	scenario(this).allowedRoleArn = roleArn;
});

Given(
	"tenant {string} is seeded for integration test user {string}",
	async function (this: ChatticusWorld, tenantId: string, userId: string) {
		const state = scenario(this);
		await seedIntegrationTestOrganization(
			{ store: this.messagingStore(), clock: this.clock, ids: this.ids },
			{ tenantId, userId },
		);
		state.tenantId = tenantId;
		state.userId = userId;
		state.config = await loadIntegrationTestAuthConfig({
			environment: state.environment,
			invokeKey: INTEGRATION_TEST_INVOKE_KEY,
			allowedRoleArn: state.allowedRoleArn,
			tenantId,
			userId,
			enabled: true,
			callerVerifier: callerVerifierFromRoleHeader,
			now: () => this.clock.now(),
		});
		await wireIntegrationTestFrontDoor(this, state.config);
	},
);

Given("the integration test front door is wired", async function (this: ChatticusWorld) {
	const state = scenario(this);
	state.config = await loadIntegrationTestAuthConfig({
		environment: state.environment,
		invokeKey: INTEGRATION_TEST_INVOKE_KEY,
		allowedRoleArn: state.allowedRoleArn,
		enabled: true,
		callerVerifier: callerVerifierFromRoleHeader,
		now: () => this.clock.now(),
	});
	await wireIntegrationTestFrontDoor(this, state.config);
});

When(
	"the integration test client requests a session with role {string}",
	async function (this: ChatticusWorld, roleArn: string) {
		assert.ok(this.api, "The scenario has no HTTP front door.");
		scenario(this).sessionResponse = await recordResponse(
			await this.api.post(INTEGRATION_TEST_SESSION_PATH, { headers: { ...frontDoorHeaders(), [ROLE_HEADER]: roleArn } }),
		);
	},
);

When("the integration test client requests a session without caller credentials", async function (this: ChatticusWorld) {
	assert.ok(this.api, "The scenario has no HTTP front door.");
	scenario(this).sessionResponse = await recordResponse(
		await this.api.post(INTEGRATION_TEST_SESSION_PATH, { headers: frontDoorHeaders() }),
	);
});

Then("the integration test session response status is {int}", function (this: ChatticusWorld, status: number) {
	const response = scenario(this).sessionResponse;
	assert.ok(response, "No session response was recorded.");
	assert.equal(response.status, status, response.text);
});

Then("the integration test session response includes a bearer token", function (this: ChatticusWorld) {
	const state = scenario(this);
	assert.ok(state.sessionResponse?.json?.token);
	state.bearer = state.sessionResponse.json.token;
});

Given("the integration test client has a session bearer token", function (this: ChatticusWorld) {
	scenario(this).bearer = mintIntegrationTestToken(configuration(this));
});

Given("the integration test client has an expired session bearer token", function (this: ChatticusWorld) {
	scenario(this).bearer = mintIntegrationTestTokenExpired(configuration(this));
});

When("the integration test client creates a channel with bot {string}", async function (this: ChatticusWorld, botName: string) {
	await createChannelFor(this, scenario(this).userId, botName);
});

When(
	"the integration test client creates a channel for user {string} with bot {string}",
	async function (this: ChatticusWorld, userId: string, botName: string) {
		await createChannelFor(this, userId, botName);
	},
);

Then("the integration test channel response status is {int}", function (this: ChatticusWorld, status: number) {
	const response = scenario(this).channelResponse;
	assert.ok(response, "No channel response was recorded.");
	assert.equal(response.status, status, response.text);
});

When(
	"the integration test client posts {string} addressed to bot {string}",
	async function (this: ChatticusWorld, body: string, botName: string) {
		const state = scenario(this);
		assert.ok(this.api, "The scenario has no HTTP front door.");
		assert.ok(state.channel, "No integration test channel was created.");
		const bot = state.botsByName.get(botName);
		assert.ok(bot, `No bot named ${JSON.stringify(botName)} was created.`);
		state.postResponse = await recordResponse(
			await this.api.post(`/orgs/${state.tenantId}/channels/${state.channel.channel_id}/messages`, {
				headers: bearerHeaders(this),
				body: { author_kind: "human", author_id: state.userId, body, addressed_to_bot_id: bot.bot_id },
			}),
		);
	},
);

Then("the integration test post message response status is {int}", function (this: ChatticusWorld, status: number) {
	const response = scenario(this).postResponse;
	assert.ok(response, "No post message response was recorded.");
	assert.equal(response.status, status, response.text);
});

Given("a worker registered over HTTP as:", async function (this: ChatticusWorld, table: DataTable) {
	const values = table.rowsHash();
	await registerWorkerOverHttp(this, {
		tenantId: values["tenant_id"] as string,
		workerId: values["worker_id"] as string,
		costClass: values["cost_class"] as string,
		capabilities: (values["capabilities"] as string)
			.split(",")
			.map((capability) => capability.trim())
			.filter((capability) => capability !== ""),
		...(values["computer_id"] ? { computerId: values["computer_id"] } : {}),
		headers: frontDoorHeaders(),
	});
});

When(
	"the integration test client claims turn {string} as worker {string}",
	async function (this: ChatticusWorld, turnId: string, workerId: string) {
		const state = scenario(this);
		assert.ok(this.api, "The scenario has no HTTP front door.");
		state.workerRouteResponse = await recordResponse(
			await this.api.post(`/orgs/${state.tenantId}/turns/${turnId}/claim`, {
				headers: bearerHeaders(this),
				body: { worker_id: workerId },
			}),
		);
	},
);

Then("the integration test worker route response status is {int}", function (this: ChatticusWorld, status: number) {
	const response = scenario(this).workerRouteResponse;
	assert.ok(response, "No worker route response was recorded.");
	assert.equal(response.status, status, response.text);
});
