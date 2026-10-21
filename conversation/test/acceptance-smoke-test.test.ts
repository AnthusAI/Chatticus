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
	SmokeCombinedError,
	SmokeRequestError,
	SMOKE_BOARD_CHECK_NAMES,
	SMOKE_CHECK_NAMES,
	type SmokeTestOptions,
} from "../src/acceptance/smoke-test.ts";
import { buildStsGetCallerIdentityHeaders } from "../src/acceptance/sigv4.ts";
import type { TurnRunJob } from "../src/domain/turn-admission.ts";
import { executeTurn } from "../src/turn/executor.ts";
import { defaultScriptedAnswer, executorDepsFor, modelScenarioOf } from "../features-support/executor-harness.ts";
import { boardScenarioOf } from "../features-support/bot-board-support.ts";
import { wireFrontDoor, TURN_RUN_QUEUE } from "../features-support/front-door.ts";
import { dropPiStorage } from "../features-support/pi-storage.ts";
import { ChatticusWorld } from "../features-support/world.ts";

const ALLOWED_ROLE = "arn:aws:iam::123456789012:role/smoke-runner";
const INVOKE_KEY = "smoke-invoke-key";
const BASE_URL = "http://front-door.test";
const CREDENTIALS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", sessionToken: "token" };

const callerVerifier: CallerVerifier = async (request) => {
	const authorization = request.headers.get("x-chatticus-sts-authorization") ?? "";
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

	it.each(["x".repeat(INVOKE_KEY.length), "short", `${INVOKE_KEY}-and-more`])(
		"fails the session check with a 403 when the invoke key is wrong (%s)",
		async (wrongKey) => {
			const checks: string[] = [];
			const failure = runSmokeTest(options({ invokeKey: wrongKey }), checks);
			await expect(failure).rejects.toBeInstanceOf(SmokeRequestError);
			await expect(failure).rejects.toMatchObject({ status: 403 });
			expect(checks).toEqual([]);
		},
		60_000,
	);

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

async function enableBoardService(): Promise<void> {
	boardScenarioOf(world).enabled = true;
	if (world.frontDoorOptions === null) {
		throw new Error("front door not wired");
	}
	await wireFrontDoor(world, world.frontDoorOptions);
}

function smokeBoards(): Array<{ cards: Record<string, any>[]; archived: boolean }> {
	const fake = boardScenarioOf(world).fake;
	return [...fake.boards.entries()].map(([key, board]) => {
		const [tenant, project] = key.split("/");
		return { cards: fake.cardsOf(tenant!, project!), archived: board.archivedAt !== null };
	});
}

function smokeBotBoard(): { cards: Record<string, any>[]; archived: boolean } {
	const boards = smokeBoards();
	const board = boards[boards.length - 1];
	if (board === undefined) {
		throw new Error("no board was provisioned");
	}
	return board;
}

describe("the board checks of the acceptance smoke test", () => {
	const orderedWithBoard = [...Object.values(SMOKE_CHECK_NAMES), ...Object.values(SMOKE_BOARD_CHECK_NAMES)];

	it("runs the board checks through the front door as the integration user and archives the board at the end", async () => {
		await enableBoardService();
		const checks: string[] = [];
		await runSmokeTest(options({ expectBoard: true }), checks);
		expect(checks).toEqual(orderedWithBoard);
		const board = smokeBotBoard();
		expect(smokeBoards().map((each) => each.archived)).toEqual([true, true]);
		const actor = `chatticus:user:${DEFAULT_INTEGRATION_TEST_USER_ID}`;
		const closing = board.cards.map((card) => [card["status"], card["custom"]?.closing, card["creator"]]);
		expect(closing).toEqual([
			["closed", "completed", actor],
			["closed", "abandoned", actor],
			["open", undefined, actor],
		]);
		expect(board.cards[0]!["comments"].at(-1).text).toContain("Smoke evidence");
	}, 60_000);

	it("skips the board checks when the board capability is not expected, even where the deployment has it", async () => {
		await enableBoardService();
		const checks: string[] = [];
		await runSmokeTest(options(), checks);
		expect(checks).toEqual(Object.values(SMOKE_CHECK_NAMES));
		const requests = boardScenarioOf(world).fake.requests;
		expect(requests.every((request) => request.method === "PUT" && request.path.endsWith("/api/config"))).toBe(true);
		expect(smokeBoards()).toEqual([{ cards: [], archived: false }]);
	}, 60_000);

	it("fails when the board capability is expected and the front door answers board_service_not_enabled", async () => {
		const checks: string[] = [];
		const failure = runSmokeTest(options({ expectBoard: true }), checks);
		await expect(failure).rejects.toBeInstanceOf(SmokeAssertionError);
		await expect(failure).rejects.toThrow(/board_service_not_enabled/);
		expect(checks).toEqual([...Object.values(SMOKE_CHECK_NAMES), SMOKE_BOARD_CHECK_NAMES.botCreated]);
	}, 60_000);

	it("reports a board failure without masking the core results", async () => {
		await enableBoardService();
		const inner = inProcessTransport();
		const breaksMoves: Transport = async (input, init) => (init?.method === "PATCH" ? new Response("{}", { status: 500 }) : inner(input, init));
		const checks: string[] = [];
		const failure = runSmokeTest(options({ expectBoard: true, fetch: breaksMoves }), checks);
		await expect(failure).rejects.toThrow(SMOKE_BOARD_CHECK_NAMES.cardMoved);
		expect(checks).toEqual(expect.arrayContaining(Object.values(SMOKE_CHECK_NAMES)));
		expect(smokeBoards().map((each) => each.archived)).toEqual([true, true]);
	}, 60_000);

	it("reports both a core failure and a board failure, and a cleanup failure as well", async () => {
		await enableBoardService();
		pumping = false;
		await pump;
		const inner = inProcessTransport();
		const breaks: Transport = async (input, init) =>
			init?.method === "PATCH" || input.endsWith("/archive") ? new Response("{}", { status: 500 }) : inner(input, init);
		const checks: string[] = [];
		const failure = runSmokeTest(options({ expectBoard: true, turnTimeoutSeconds: 1, fetch: breaks }), checks);
		await expect(failure).rejects.toBeInstanceOf(SmokeCombinedError);
		await expect(failure).rejects.toThrow(/did not complete[\s\S]*also[\s\S]*board card moved to in_progress[\s\S]*also[\s\S]*board archived at cleanup/);
	}, 60_000);

	it("fails when completing a card without evidence is not refused, and still archives the board", async () => {
		await enableBoardService();
		const inner = inProcessTransport();
		const sneaky: Transport = async (input, init) => {
			const body = typeof init?.body === "string" ? init.body : "";
			if (init?.method === "POST" && input.endsWith("/complete") && body.includes('"evidence":""')) {
				return inner(input, { ...init, body: JSON.stringify({ evidence: "slipped through" }) });
			}
			return inner(input, init);
		};
		const checks: string[] = [];
		const failure = runSmokeTest(options({ expectBoard: true, fetch: sneaky }), checks);
		await expect(failure).rejects.toBeInstanceOf(SmokeAssertionError);
		await expect(failure).rejects.toThrow(SMOKE_BOARD_CHECK_NAMES.completionRefused);
		expect(checks).not.toContain(SMOKE_BOARD_CHECK_NAMES.completionRefused);
		expect(checks).not.toContain(SMOKE_BOARD_CHECK_NAMES.boardArchived);
		expect(smokeBotBoard().archived).toBe(true);
	}, 60_000);

	it("fails when a card read back is not closed as completed", async () => {
		await enableBoardService();
		const inner = inProcessTransport();
		const dropsClosing: Transport = async (input, init) => {
			const response = await inner(input, init);
			if ((init?.method ?? "GET") !== "GET" || !/\/board\/cards\/[^/]+$/.test(input)) {
				return response;
			}
			const answer = (await response.json()) as { issue: Record<string, any>; revision: string };
			answer.issue["custom"] = {};
			return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
		};
		const checks: string[] = [];
		const failure = runSmokeTest(options({ expectBoard: true, fetch: dropsClosing }), checks);
		await expect(failure).rejects.toThrow(/records the closing/);
		expect(checks).not.toContain(SMOKE_BOARD_CHECK_NAMES.cardCompleted);
		expect(smokeBotBoard().archived).toBe(true);
	}, 60_000);
});

describe("the STS identity proof the smoke test sends", () => {
	it("signs only headers the front door relays to STS", async () => {
		const headers = await buildStsGetCallerIdentityHeaders(CREDENTIALS);
		expect(headers["x-chatticus-sts-authorization"]).toMatch(/SignedHeaders=host;x-amz-date;x-amz-security-token,/);
		expect(Object.keys(headers).sort()).toEqual(["x-amz-date", "x-amz-security-token", "x-chatticus-sts-authorization"]);
		expect(headers).not.toHaveProperty("authorization");
	});
});
