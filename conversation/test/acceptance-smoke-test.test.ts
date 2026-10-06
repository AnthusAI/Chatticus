import type { IWorldOptions } from "@cucumber/cucumber";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cucumber/cucumber", () => ({ World: class {}, setWorldConstructor: () => undefined }));

import {
	loadIntegrationTestAuthConfig,
	seedIntegrationTestOrganization,
	DEFAULT_INTEGRATION_TEST_TENANT_ID,
	DEFAULT_INTEGRATION_TEST_USER_ID,
	type CallerVerifier,
} from "../src/auth/integration-test.ts";
import {
	runSmokeTest,
	SmokeAssertionError,
	SmokeRequestError,
	SMOKE_CHECK_NAMES,
	type SmokeTestOptions,
} from "../src/acceptance/smoke-test.ts";
import { buildStsGetCallerIdentityHeaders } from "../src/acceptance/sigv4.ts";
import type { TurnRunJob } from "../src/domain/turn-admission.ts";
import { executeTurn } from "../src/turn/executor.ts";
import { defaultScriptedAnswer, executorDepsFor, modelScenarioOf } from "../features-support/executor-harness.ts";
import { wireFrontDoor, TURN_RUN_QUEUE } from "../features-support/front-door.ts";
import { dropPiStorage } from "../features-support/pi-storage.ts";
import { ChatticusWorld } from "../features-support/world.ts";

const ALLOWED_ROLE = "arn:aws:iam::123456789012:role/smoke-runner";
const INVOKE_KEY = "smoke-invoke-key";
const BASE_URL = "http://front-door.test";
const CREDENTIALS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", sessionToken: "token" };

const callerVerifier: CallerVerifier = async (request) => {
	const authorization = request.headers.get("authorization") ?? "";
	return authorization.startsWith("AWS4-HMAC-SHA256") && request.headers.get("x-amz-date") ? ALLOWED_ROLE : null;
};

type Transport = (input: string, init?: RequestInit) => Promise<Response>;

let world: ChatticusWorld;
let pumping = false;
let pump: Promise<void> = Promise.resolve();

function inProcessTransport(): Transport {
	const app = world.app;
	if (app === null) {
		throw new Error("front door not wired");
	}
	return async (input, init) => app.request(input, init);
}

async function runQueuedTurns(): Promise<void> {
	while (pumping) {
		const queued = world.queues.take(TURN_RUN_QUEUE, () => true);
		if (queued === null) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			continue;
		}
		const job = queued.body as TurnRunJob;
		const scenario = modelScenarioOf(world);
		for (let answer = 1; answer <= 4; answer += 1) {
			scenario.scripted.reply(defaultScriptedAnswer(scenario.scripted.callCount + answer));
		}
		const deps = await executorDepsFor(world, scenario);
		void executeTurn({ tenantId: job.tenantId, turnId: job.turnId, botId: job.botId }, deps);
	}
}

function options(overrides: Partial<SmokeTestOptions> = {}): SmokeTestOptions {
	return {
		baseUrl: BASE_URL,
		invokeKey: INVOKE_KEY,
		credentials: CREDENTIALS,
		turnTimeoutSeconds: 20,
		fetch: inProcessTransport(),
		...overrides,
	};
}

function reloadRewritten(rewrite: (messages: Array<Record<string, unknown>>) => Array<Record<string, unknown>>): Transport {
	const inner = inProcessTransport();
	return async (input, init) => {
		const response = await inner(input, init);
		if (!/\/messages\?after=/.test(input) || (init?.method ?? "GET") !== "GET") {
			return response;
		}
		const body = (await response.json()) as { messages: Array<Record<string, unknown>> };
		return new Response(JSON.stringify({ messages: rewrite(body.messages) }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
}

beforeEach(async () => {
	world = new ChatticusWorld({ attach: () => undefined, log: () => undefined, parameters: {}, link: () => undefined } as unknown as IWorldOptions);
	await world.messagingTable.create();
	const config = await loadIntegrationTestAuthConfig({
		environment: "development",
		invokeKey: INVOKE_KEY,
		allowedRoleArn: ALLOWED_ROLE,
		enabled: true,
		callerVerifier,
		now: () => world.clock.now(),
	});
	await seedIntegrationTestOrganization(
		{ store: world.messagingStore(), clock: world.clock, ids: world.ids },
		{ tenantId: DEFAULT_INTEGRATION_TEST_TENANT_ID, userId: DEFAULT_INTEGRATION_TEST_USER_ID },
	);
	await wireFrontDoor(world, {
		signupMode: "invitation_only",
		cognitoVerifier: true,
		environment: "development",
		invokeKey: INVOKE_KEY,
		integrationTest: config,
	});
	pumping = true;
	pump = runQueuedTurns();
});

afterEach(async () => {
	pumping = false;
	await pump;
	await dropPiStorage(world);
	await world.messagingTable.drop();
	world.messagingTable.client.destroy();
});

describe("the acceptance smoke test against the in-process front door", () => {
	it("passes every check in order against a front door whose bot answers", async () => {
		const checks: string[] = [];
		await runSmokeTest(options(), checks);
		expect(checks).toEqual(Object.values(SMOKE_CHECK_NAMES));
	}, 60_000);

	it("fails the session check when the invoke key is wrong", async () => {
		const checks: string[] = [];
		await expect(runSmokeTest(options({ invokeKey: "x".repeat(INVOKE_KEY.length) }), checks)).rejects.toBeInstanceOf(SmokeRequestError);
		expect(checks).toEqual([]);
	}, 60_000);

	it("fails when the turn never completes", async () => {
		pumping = false;
		await pump;
		const checks: string[] = [];
		await expect(runSmokeTest(options({ turnTimeoutSeconds: 1 }), checks)).rejects.toThrow(/did not complete/);
		expect(checks).not.toContain(SMOKE_CHECK_NAMES.streamCompleted);
		expect(checks).toContain(SMOKE_CHECK_NAMES.steerAdmitted);
	}, 60_000);

	it("fails when the reloaded channel is not in ascending order", async () => {
		const checks: string[] = [];
		const failure = runSmokeTest(options({ fetch: reloadRewritten((messages) => [...messages].reverse()) }), checks);
		await expect(failure).rejects.toBeInstanceOf(SmokeAssertionError);
		await expect(failure).rejects.toThrow(SMOKE_CHECK_NAMES.reloadOrdered);
		expect(checks).not.toContain(SMOKE_CHECK_NAMES.reloadOrdered);
	}, 60_000);

	it("fails when a later human message carries a sequence that does not ascend", async () => {
		const checks: string[] = [];
		const failure = runSmokeTest(
			options({
				fetch: reloadRewritten((messages) =>
					messages.map((message, index) => (index > 0 && message["author_kind"] === "human" ? { ...message, seq: 0 } : message)),
				),
			}),
			checks,
		);
		await expect(failure).rejects.toThrow(/not in ascending seq order/);
		expect(checks).not.toContain(SMOKE_CHECK_NAMES.reloadOrdered);
	}, 60_000);

	it("fails when the bot reply sits before the human message it answers", async () => {
		const checks: string[] = [];
		const failure = runSmokeTest(
			options({
				fetch: reloadRewritten((messages) => {
					const first = messages.find((message) => message["author_kind"] === "human");
					return messages
						.map((message) => (message === first ? { ...message, seq: Number(message["seq"]) + 1000 } : message))
						.sort((left, right) => Number(left["seq"]) - Number(right["seq"]));
				}),
			}),
			checks,
		);
		await expect(failure).rejects.toThrow(/not after the human message/);
		expect(checks).not.toContain(SMOKE_CHECK_NAMES.reloadOrdered);
	}, 60_000);

	it("fails when the bot reply is not persisted after the human message", async () => {
		const checks: string[] = [];
		const failure = runSmokeTest(
			options({ fetch: reloadRewritten((messages) => messages.filter((message) => message["author_kind"] !== "bot")) }),
			checks,
		);
		await expect(failure).rejects.toBeInstanceOf(SmokeAssertionError);
		expect(checks).not.toContain(SMOKE_CHECK_NAMES.replyPersisted);
	}, 60_000);

	it("fails when a persisted bot reply has an empty body", async () => {
		const checks: string[] = [];
		const failure = runSmokeTest(
			options({
				fetch: reloadRewritten((messages) =>
					messages.map((message) => (message["author_kind"] === "bot" ? { ...message, body: "" } : message)),
				),
			}),
			checks,
		);
		await expect(failure).rejects.toThrow(SMOKE_CHECK_NAMES.replyPersisted);
		expect(checks).not.toContain(SMOKE_CHECK_NAMES.replyPersisted);
	}, 60_000);
});

describe("the STS identity proof the smoke test sends", () => {
	it("signs only headers the front door relays to STS", async () => {
		const headers = await buildStsGetCallerIdentityHeaders(CREDENTIALS);
		expect(headers["authorization"]).toMatch(/SignedHeaders=host;x-amz-date;x-amz-security-token,/);
		expect([...new Set(Object.keys(headers).map((name) => name.toLowerCase()))].sort()).toEqual(["authorization", "host", "x-amz-date", "x-amz-security-token"]);
	});
});
