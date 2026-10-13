import assert from "node:assert/strict";
import { Given, Then, When, type DataTable } from "@cucumber/cucumber";
import {
	OWNER_BOOTSTRAP_TOKEN_LIFETIME_SECONDS,
	OWNER_CREDENTIAL_LIFETIME_SECONDS,
	OWNER_PROTOCOL_VERSION,
	type OwnerDispatch,
	type OwnerPollResponse,
} from "@chatticus/host-protocol/supervisor";
import { Decimal } from "../../src/budget/decimal.ts";
import { ensureComputer, liveOwnerOfOrganization, requestComputerHostStart } from "../../src/domain/computers.ts";
import { failStaleTurn, getTurn } from "../../src/domain/turns.ts";
import { registerWorker } from "../../src/domain/workers.ts";
import { ownerSessionTags, supervisorSessionTags } from "../../src/gateway/session-tags.ts";
import {
	mintComputerOwnerToken,
	mintOwnerBootstrapToken,
	mintSessionToken,
	verifyComputerOwnerToken,
	verifySessionToken,
} from "../../src/gateway/session-token.ts";
import { actionStoreOf } from "../computer-support.ts";
import { computerScenarioOf, deliverStartJob, queuedStartJobs, STORY_TENANT, STORY_USER, workTurn } from "../computer-scenario.ts";
import { startComputerOwner } from "../computer-owner.ts";
import { modelScenarioOf } from "../executor-harness.ts";
import { FakeHostStartDriver } from "../fakes/fake-host-start-driver.ts";
import { wireFrontDoor } from "../front-door.ts";
import { SCENARIO_GATEWAY_SIGNING_KEY } from "../model-gateway-support.ts";
import { ownerBrokerOf } from "../owner-broker-support.ts";
import { ABOVE_CEILING_MONTH_TO_DATE_USD, spendToday } from "../spend-ceiling.ts";
import { ensureMember } from "../turn-grant-support.ts";
import type { ChatticusWorld } from "../world.ts";
import { openChannelWithNamedBot } from "./message.steps.ts";
import { postToBot } from "../turn-recovery.ts";

const OWNER_INVOKE_KEY = "deployment-invoke-key";
const OTHER_SIGNING_KEY = "a-different-signing-key-0123456789abcdef";
const BOOT_SECONDS = 61;

type AnswerRecord = { status: number; body: any };

/** What a scenario about the owner routes remembers between its steps. */
export type OwnerServerScenario = {
	frontDoorWired: boolean;
	ownerId: string;
	computerId: string;
	generation: number;
	bootstrapToken: string;
	supervisorToken: string;
	nextSequence: number;
	last: AnswerRecord;
	bootstrapAnswers: AnswerRecord[];
	polls: OwnerPollResponse[];
	lastPollBody: Record<string, unknown> | null;
	dispatches: OwnerDispatch[];
	turnsByBot: Map<string, string>;
	lastStop: { approved: boolean; reason?: string } | null;
	concurrent: { stop: AnswerRecord; poll: AnswerRecord } | null;
	firstOwner: { ownerId: string; supervisorToken: string } | null;
};

const scenarios = new WeakMap<ChatticusWorld, OwnerServerScenario>();

/** The scenario's owner state, created on first use. */
export function ownerServerOf(world: ChatticusWorld): OwnerServerScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		scenario = {
			frontDoorWired: false,
			ownerId: "",
			computerId: "",
			generation: 0,
			bootstrapToken: "",
			supervisorToken: "",
			nextSequence: 0,
			last: { status: 0, body: null },
			bootstrapAnswers: [],
			polls: [],
			lastPollBody: null,
			dispatches: [],
			turnsByBot: new Map(),
			lastStop: null,
			concurrent: null,
			firstOwner: null,
		};
		scenarios.set(world, scenario);
	}
	return scenario;
}

const nowSeconds = (world: ChatticusWorld): number => Math.floor(world.clock.now().getTime() / 1000);

const hostPath = (suffix: string): string => `/orgs/${STORY_TENANT}/host${suffix}`;

async function send(
	world: ChatticusWorld,
	method: string,
	path: string,
	options: { token?: string | null; body?: unknown; headers?: Record<string, string> } = {},
): Promise<AnswerRecord> {
	assert.ok(world.app, "The scenario has no HTTP front door.");
	const headers: Record<string, string> = { "content-type": "application/json", ...(options.headers ?? {}) };
	if (options.token !== undefined && options.token !== null) headers["authorization"] = `Bearer ${options.token}`;
	const response = await world.app.request(path, {
		method,
		headers,
		...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
	});
	const text = await response.text();
	let body: any = text;
	try {
		body = JSON.parse(text);
	} catch {
		body = text;
	}
	const answer = { status: response.status, body };
	ownerServerOf(world).last = answer;
	return answer;
}

function hostStartDependencies(world: ChatticusWorld) {
	const store = world.messagingStore();
	return {
		store,
		clock: world.clock,
		ids: world.ids,
		heartbeatTimeoutSeconds: world.heartbeatTimeoutSeconds,
		spend: { store, rollups: world.store, environment: world.budgetEnvironment, clock: world.clock },
	};
}

async function wireFrontDoorWithInvokeKey(world: ChatticusWorld): Promise<void> {
	const scenario = ownerServerOf(world);
	if (scenario.frontDoorWired) return;
	await wireFrontDoor(world, { signupMode: "invitation_only", cognitoVerifier: true, invokeKey: OWNER_INVOKE_KEY });
	scenario.frontDoorWired = true;
}

/**
 * What the starter does for the owner, short of running a task: it claims the next host start generation, marks it
 * dispatched, registers the owner as a worker of the computer, and signs the bootstrap token. The task then takes a minute
 * to boot, so the start lease has run out by the time the owner exchanges its token.
 */
async function startOwner(world: ChatticusWorld, options: { registerOwnerWorker: boolean }): Promise<void> {
	await ensureMember(world, STORY_TENANT, STORY_USER);
	const scenario = ownerServerOf(world);
	const store = world.messagingStore();
	const claim = await requestComputerHostStart(hostStartDependencies(world), STORY_TENANT, STORY_USER);
	assert.equal(claim.newlyClaimed, true);
	await store.markHostStartDispatched(STORY_TENANT, claim.hostStartGeneration);
	scenario.ownerId = `owner-${world.ids.next()}`;
	scenario.computerId = claim.computerId;
	scenario.generation = claim.hostStartGeneration;
	if (options.registerOwnerWorker) {
		await registerWorker(
			{ workerId: scenario.ownerId, tenantId: STORY_TENANT, costClass: "local", capabilities: ["cpu", "computer"], computerId: claim.computerId },
			{ store, clock: world.clock, ids: world.ids },
		);
	}
	scenario.bootstrapToken = mintBootstrap(world, {});
	scenario.nextSequence = 0;
	world.clock.advanceSeconds(BOOT_SECONDS);
}

function mintBootstrap(world: ChatticusWorld, overrides: Record<string, unknown>, key = SCENARIO_GATEWAY_SIGNING_KEY): string {
	const scenario = ownerServerOf(world);
	return mintOwnerBootstrapToken(key, {
		audience: "owner-bootstrap",
		tenantId: STORY_TENANT,
		computerId: scenario.computerId,
		ownerId: scenario.ownerId,
		startGeneration: scenario.generation,
		issuedAtSeconds: nowSeconds(world),
		expiresAtSeconds: nowSeconds(world) + OWNER_BOOTSTRAP_TOKEN_LIFETIME_SECONDS,
		...overrides,
	} as Parameters<typeof mintOwnerBootstrapToken>[1]);
}

function mintSupervisor(world: ChatticusWorld, overrides: Record<string, unknown>, key = SCENARIO_GATEWAY_SIGNING_KEY): string {
	const scenario = ownerServerOf(world);
	return mintComputerOwnerToken(key, {
		audience: "computer-owner",
		tenantId: STORY_TENANT,
		computerId: scenario.computerId,
		ownerId: scenario.ownerId,
		startGeneration: scenario.generation,
		issuedAtSeconds: nowSeconds(world),
		expiresAtSeconds: nowSeconds(world) + OWNER_CREDENTIAL_LIFETIME_SECONDS,
		...overrides,
	} as Parameters<typeof mintComputerOwnerToken>[1]);
}

export async function presentBootstrap(world: ChatticusWorld, token: string, body: Record<string, unknown> = {}): Promise<AnswerRecord> {
	const scenario = ownerServerOf(world);
	const answer = await send(world, "POST", hostPath("/owner/bootstrap"), {
		token,
		body: { owner_id: scenario.ownerId, generation: scenario.generation, protocol_version: OWNER_PROTOCOL_VERSION, ...body },
	});
	scenario.bootstrapAnswers.push(answer);
	if (answer.status === 200) scenario.supervisorToken = answer.body.supervisor_token;
	return answer;
}

/** Start an owner for the next host start generation and exchange its bootstrap token, leaving its supervisor token in the scenario. */
export async function bootstrapOwner(world: ChatticusWorld): Promise<void> {
	await startOwner(world, { registerOwnerWorker: true });
	const answer = await presentBootstrap(world, ownerServerOf(world).bootstrapToken);
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
}

function pollBody(world: ChatticusWorld, state: string, sequence: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const scenario = ownerServerOf(world);
	return {
		owner_id: scenario.ownerId,
		generation: scenario.generation,
		protocol_version: OWNER_PROTOCOL_VERSION,
		sequence,
		state,
		active_turns: state === "serving" ? [{ turn_id: "turn-being-served", dispatch_id: "dispatch-being-served" }] : [],
		...overrides,
	};
}

export async function poll(world: ChatticusWorld, state: string, sequence?: number, overrides: Record<string, unknown> = {}, token?: string): Promise<AnswerRecord> {
	const scenario = ownerServerOf(world);
	const used = sequence ?? scenario.nextSequence;
	scenario.nextSequence = Math.max(scenario.nextSequence, used + 1);
	const body = pollBody(world, state, used, overrides);
	scenario.lastPollBody = body;
	const answer = await send(world, "POST", hostPath("/owner/poll"), { token: token ?? scenario.supervisorToken, body });
	if (answer.status === 200) {
		scenario.polls.push(answer.body as OwnerPollResponse);
		scenario.dispatches.push(...(answer.body as OwnerPollResponse).dispatches);
	}
	return answer;
}

const lastPollOf = (world: ChatticusWorld): OwnerPollResponse => {
	const poll = ownerServerOf(world).polls.at(-1);
	assert.ok(poll, "The owner has not been answered a poll.");
	return poll;
};

async function parkTurnOf(world: ChatticusWorld, botName: string): Promise<string> {
	await ensureMember(world, STORY_TENANT, STORY_USER);
	modelScenarioOf(world).scripted.toolCall("write_workspace", { path: `/workspace/${botName.toLowerCase()}.md`, content: "draft" }, "Working on it.");
	await openChannelWithNamedBot(world, STORY_TENANT, STORY_USER, botName);
	world.lastTurnId = await postToBot(world, botName, `save the notes of ${botName}`);
	assert.equal(await workTurn(world, botName), "parked");
	ownerServerOf(world).turnsByBot.set(botName, world.lastTurnId);
	return world.lastTurnId;
}

function turnIdOfBot(world: ChatticusWorld, botName: string): string {
	const turnId = ownerServerOf(world).turnsByBot.get(botName);
	assert.ok(turnId, `No turn of bot ${botName} was parked.`);
	return turnId;
}

const computerNow = async (world: ChatticusWorld) => {
	const computer = await world.messagingStore().getComputer(STORY_TENANT);
	assert.ok(computer, "The organization has no computer.");
	return computer;
};

Given("a fake owner credential broker", function (this: ChatticusWorld) {
	ownerBrokerOf(this);
});

Given("the broker is unavailable", function (this: ChatticusWorld) {
	ownerBrokerOf(this).setReachable(false);
});

Given("the broker is available again", function (this: ChatticusWorld) {
	ownerBrokerOf(this).setReachable(true);
});

Given("the starter has started an owner for generation {int}", async function (this: ChatticusWorld, generation: number) {
	await startOwner(this, { registerOwnerWorker: true });
	assert.equal(ownerServerOf(this).generation, generation);
});

Given("the starter has started an owner for generation {int} but registered no worker", async function (this: ChatticusWorld, generation: number) {
	await startOwner(this, { registerOwnerWorker: false });
	assert.equal(ownerServerOf(this).generation, generation);
});

Given("a bootstrapped owner of the household computer", async function (this: ChatticusWorld) {
	await bootstrapOwner(this);
});

Given("a bootstrapped owner of the household computer that has not finished hydrating", async function (this: ChatticusWorld) {
	await bootstrapOwner(this);
	const answer = await poll(this, "hydrating");
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
});

Given("a published snapshot newer than the hydrated one", async function (this: ChatticusWorld) {
	const computer = await computerNow(this);
	await this.messagingStore().putComputer({ ...computer, snapshotGeneration: computer.snapshotGeneration + 1, snapshotUri: "s3://snapshots/household" });
});

Given("a turn of bot {string} parked on a workspace action", async function (this: ChatticusWorld, botName: string) {
	await parkTurnOf(this, botName);
});

When("a turn of bot {string} parks on a workspace action", async function (this: ChatticusWorld, botName: string) {
	await parkTurnOf(this, botName);
});

Given("a turn of bot {string} that failed while its workspace action was still requested", async function (this: ChatticusWorld, botName: string) {
	const turnId = await parkTurnOf(this, botName);
	const deps = this.turnDependencies();
	const turn = await getTurn(deps, STORY_TENANT, turnId);
	const failed = await failStaleTurn(deps, turn, "waiting", "The scenario failed the turn while it waited.");
	assert.ok(failed, "The turn could not be failed.");
	const [action] = await actionStoreOf(this).listForTurn(STORY_TENANT, turnId);
	assert.equal(action?.status, "requested");
});

Given("a dispatch offered for a parked turn of bot {string}", async function (this: ChatticusWorld, botName: string) {
	await parkTurnOf(this, botName);
	const answer = await poll(this, "idle");
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
	assert.equal(lastPollOf(this).dispatches.length, 1);
});

Given("a turn that the owner claimed whose lease has not run out", async function (this: ChatticusWorld) {
	await parkTurnOf(this, "Researcher");
	const answer = await poll(this, "idle");
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
	assert.equal(lastPollOf(this).dispatches.length, 1);
	const { held } = await startComputerOwner(this, "claimed-by-the-owner", { hold: true, workerId: ownerServerOf(this).ownerId });
	assert.ok(held);
	await held.reached;
});

Given("the organization sets a monthly AWS spend ceiling of {string} dollars and has spent more", async function (this: ChatticusWorld, amount: string) {
	const store = this.messagingStore();
	const organization = await store.getOrganization(STORY_TENANT);
	assert.ok(organization, "The organization does not exist.");
	await store.putOrganization({ ...organization, monthlyAwsSpendCeilingUsd: Decimal.parse(amount) });
	this.spendCeilingScenario = {
		tenantId: STORY_TENANT,
		ownerUserId: STORY_USER,
		memberUserId: null,
		channelId: null,
		ceilingResponse: null,
		channelsResponse: null,
	};
	await spendToday(this, ABOVE_CEILING_MONTH_TO_DATE_USD);
});

Given("a newer host start generation has been claimed", async function (this: ChatticusWorld) {
	this.clock.advanceSeconds(BOOT_SECONDS);
	const claim = await requestComputerHostStart(hostStartDependencies(this), STORY_TENANT, STORY_USER);
	assert.equal(claim.hostStartGeneration, ownerServerOf(this).generation + 1);
});

Given("the start lease of the owner's generation has expired", async function (this: ChatticusWorld) {
	const computer = await computerNow(this);
	assert.ok(
		computer.hostStartLeaseExpiresAt === undefined || computer.hostStartLeaseExpiresAt.getTime() <= this.clock.now().getTime(),
		"The start lease of the owner's generation is still held.",
	);
});

When("the clock moves {int} seconds", function (this: ChatticusWorld, seconds: number) {
	this.clock.advanceSeconds(seconds);
});

When("the clock has moved {int} seconds past the owner's bootstrap", async function (this: ChatticusWorld, seconds: number) {
	const computer = await computerNow(this);
	assert.ok(computer.ownerStartedAt, "The computer records no owner start.");
	const elapsed = (this.clock.now().getTime() - computer.ownerStartedAt.getTime()) / 1000;
	this.clock.advanceSeconds(seconds - elapsed);
});

When("the owner has been idle for {int} seconds", function (this: ChatticusWorld, seconds: number) {
	this.clock.advanceSeconds(seconds);
});

When("the owner presents its bootstrap token on the bootstrap route", async function (this: ChatticusWorld) {
	await presentBootstrap(this, ownerServerOf(this).bootstrapToken);
});

When("the same bootstrap token is presented again", async function (this: ChatticusWorld) {
	await presentBootstrap(this, ownerServerOf(this).bootstrapToken);
});

When(/^the owner presents a bootstrap token that is (.+)$/, async function (this: ChatticusWorld, fault: string) {
	const claimsGeneration = ownerServerOf(this).generation;
	const faults: Record<string, () => Promise<AnswerRecord>> = {
		expired: () => presentBootstrap(this, mintBootstrap(this, { issuedAtSeconds: nowSeconds(this) - 400, expiresAtSeconds: nowSeconds(this) - 1 })),
		"signed with another key": () => presentBootstrap(this, mintBootstrap(this, {}, OTHER_SIGNING_KEY)),
		"a gateway token": () =>
			presentBootstrap(
				this,
				mintSessionToken(SCENARIO_GATEWAY_SIGNING_KEY, {
					audience: "model-gateway",
					tenantId: STORY_TENANT,
					botId: "bot-1",
					turnId: "turn-1",
					ownerId: ownerServerOf(this).ownerId,
					startGeneration: claimsGeneration,
					expiresAtSeconds: nowSeconds(this) + 300,
				}),
			),
		"a supervisor token": () => presentBootstrap(this, mintSupervisor(this, {})),
		"for another organization": () => presentBootstrap(this, mintBootstrap(this, { tenantId: "other-organization" })),
		"for generation 2 while generation 1 runs": () =>
			presentBootstrap(this, mintBootstrap(this, { startGeneration: claimsGeneration + 1 }), { generation: claimsGeneration + 1 }),
		"for an owner id other than the request's": () => presentBootstrap(this, mintBootstrap(this, { ownerId: "owner-another" })),
	};
	const present = faults[fault];
	assert.ok(present, `Unknown bootstrap fault ${fault}`);
	await present();
});

When("the owner polls in state {string}", async function (this: ChatticusWorld, state: string) {
	await poll(this, state);
});

When("the owner polls in state {string} with sequence {int}", async function (this: ChatticusWorld, state: string, sequence: number) {
	await poll(this, state, sequence);
});

When("the owner polls again in state {string} with sequence {int}", async function (this: ChatticusWorld, state: string, sequence: number) {
	await poll(this, state, sequence);
});

When("the owner repeats the poll with sequence {int}", async function (this: ChatticusWorld, sequence: number) {
	const body = ownerServerOf(this).lastPollBody;
	assert.ok(body, "The owner has not polled.");
	await poll(this, String(body["state"]), sequence);
});

When("the owner polls in state {string} with the dispatched turn and sequence {int}", async function (this: ChatticusWorld, state: string, sequence: number) {
	const dispatch = ownerServerOf(this).dispatches.at(-1);
	assert.ok(dispatch, "No dispatch was offered.");
	await poll(this, state, sequence, { active_turns: [{ turn_id: dispatch.turn_id, dispatch_id: dispatch.dispatch_id }] });
});

When("the owner polls in state {string} with no active turn and sequence {int}", async function (this: ChatticusWorld, state: string, sequence: number) {
	await poll(this, state, sequence, { active_turns: [] });
});

When("the owner polls as owner {string} in state {string} with sequence {int}", async function (this: ChatticusWorld, ownerId: string, state: string, sequence: number) {
	await poll(this, state, sequence, { owner_id: ownerId });
});

When(/^the owner polls with a supervisor token that is (.+)$/, async function (this: ChatticusWorld, fault: string) {
	const faults: Record<string, string> = {
		expired: mintSupervisor(this, { issuedAtSeconds: nowSeconds(this) - 4000, expiresAtSeconds: nowSeconds(this) - 1 }),
		"signed with another key": mintSupervisor(this, {}, OTHER_SIGNING_KEY),
		"a model gateway token": mintSessionToken(SCENARIO_GATEWAY_SIGNING_KEY, {
			audience: "model-gateway",
			tenantId: STORY_TENANT,
			botId: "bot-1",
			turnId: "turn-1",
			ownerId: ownerServerOf(this).ownerId,
			startGeneration: ownerServerOf(this).generation,
			expiresAtSeconds: nowSeconds(this) + 300,
		}),
		"a bootstrap token": mintBootstrap(this, {}),
		"for another organization": mintSupervisor(this, { tenantId: "other-organization" }),
		"for another owner id": mintSupervisor(this, { ownerId: "owner-another" }),
		"for a computer that is not this one": mintSupervisor(this, { computerId: "computer-another" }),
	};
	const token = faults[fault];
	assert.ok(token, `Unknown supervisor token fault ${fault}`);
	await poll(this, "idle", undefined, {}, token);
});

function ownerCallOf(world: ChatticusWorld, route: string): { method: string; path: string; body?: unknown } {
	const scenario = ownerServerOf(world);
	const [method, suffix] = route.split(" ") as [string, string];
	const bodies: Record<string, unknown> = {
		"/owner/poll": pollBody(world, "idle", 1000),
		"/owner/stop-request": { owner_id: scenario.ownerId, generation: scenario.generation, reason: "idle", active_turns: [] },
		"/computer/state": { stopped: false },
		"/snapshot/published": { worker_id: scenario.ownerId, checksum: "checksum-1" },
		"/snapshot/hydrated": { worker_id: scenario.ownerId },
	};
	const organizationRoutes = ["/workers/register", "/model-gateway/v1/responses", "/users/ryan/computer"];
	const path = organizationRoutes.includes(suffix) ? `/orgs/${STORY_TENANT}${suffix}` : hostPath(suffix);
	const body = method === "GET" ? undefined : (bodies[suffix] ?? {});
	return { method, path, ...(body === undefined ? {} : { body }) };
}

When("the owner calls {string}", async function (this: ChatticusWorld, route: string) {
	const call = ownerCallOf(this, route);
	await send(this, call.method, call.path, { token: ownerServerOf(this).supervisorToken, ...(call.body === undefined ? {} : { body: call.body }) });
});

When("the owner calls {string} with its supervisor token", async function (this: ChatticusWorld, route: string) {
	await wireFrontDoorWithInvokeKey(this);
	const call = ownerCallOf(this, route);
	await send(this, call.method, call.path, { token: ownerServerOf(this).supervisorToken, ...(call.body === undefined ? {} : { body: call.body }) });
});

When("a caller with the invoke key and no token calls {string}", async function (this: ChatticusWorld, route: string) {
	await wireFrontDoorWithInvokeKey(this);
	const call = ownerCallOf(this, route);
	await send(this, call.method, call.path, { headers: { "X-Chatticus-Invoke-Key": OWNER_INVOKE_KEY }, ...(call.body === undefined ? {} : { body: call.body }) });
});

When("the owner asks to stop with reason {string}", async function (this: ChatticusWorld, reason: string) {
	const scenario = ownerServerOf(this);
	const answer = await send(this, "POST", hostPath("/owner/stop-request"), {
		token: scenario.supervisorToken,
		body: { owner_id: scenario.ownerId, generation: scenario.generation, reason, active_turns: [] },
	});
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
	scenario.lastStop = answer.body;
});

When("the control plane judges a stop request and a poll for the same owner at the same moment", async function (this: ChatticusWorld) {
	const scenario = ownerServerOf(this);
	const [stop, pollAnswer] = await Promise.all([
		send(this, "POST", hostPath("/owner/stop-request"), {
			token: scenario.supervisorToken,
			body: { owner_id: scenario.ownerId, generation: scenario.generation, reason: "idle", active_turns: [] },
		}),
		send(this, "POST", hostPath("/owner/poll"), { token: scenario.supervisorToken, body: pollBody(this, "idle", scenario.nextSequence) }),
	]);
	scenario.concurrent = { stop, poll: pollAnswer };
	assert.equal(stop.status, 200, JSON.stringify(stop.body));
	assert.equal(pollAnswer.status, 200, JSON.stringify(pollAnswer.body));
});

When(/^the owner reports the computer stopped for generation (\d+)( again)?$/, async function (this: ChatticusWorld, generation: string, _again: string | undefined) {
	const scenario = ownerServerOf(this);
	await send(this, "POST", hostPath("/computer/state"), {
		token: scenario.supervisorToken,
		body: { stopped: true, start_generation: Number(generation) },
		headers: { "X-Chatticus-Host-User-Id": STORY_USER },
	});
});

When("the owner reports the computer stopped without naming a generation", async function (this: ChatticusWorld) {
	await send(this, "POST", hostPath("/computer/state"), {
		token: ownerServerOf(this).supervisorToken,
		body: { stopped: true },
		headers: { "X-Chatticus-Host-User-Id": STORY_USER },
	});
});

Then("the computer still has the start lease of generation {int}", async function (this: ChatticusWorld, generation: number) {
	const computer = await computerNow(this);
	assert.equal(computer.hostStartGeneration, generation);
	assert.notEqual(computer.hostStartLeaseExpiresAt, undefined);
});

Given("a second owner is bootstrapped for generation {int}", async function (this: ChatticusWorld, generation: number) {
	const scenario = ownerServerOf(this);
	scenario.firstOwner = { ownerId: scenario.ownerId, supervisorToken: scenario.supervisorToken };
	await startOwner(this, { registerOwnerWorker: true });
	assert.equal(scenario.generation, generation);
	const answer = await presentBootstrap(this, scenario.bootstrapToken);
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
});

When("the first owner reports a published snapshot", async function (this: ChatticusWorld) {
	const first = ownerServerOf(this).firstOwner;
	assert.ok(first, "No first owner was kept.");
	await send(this, "POST", hostPath("/snapshot/published"), { token: first.supervisorToken, body: { worker_id: first.ownerId, checksum: "checksum-of-a-zombie" } });
});

When("a start job for the turn is delivered to the starter", async function (this: ChatticusWorld) {
	const state = computerScenarioOf(this);
	state.driver ??= new FakeHostStartDriver();
	const turnId = this.lastTurnId;
	assert.ok(turnId, "No turn is parked.");
	const turn = await getTurn(this.turnDependencies(), STORY_TENANT, turnId);
	const computer = await computerNow(this);
	const job = {
		jobId: this.ids.next(),
		tenantId: STORY_TENANT,
		turnId,
		botId: turn.botId,
		userId: STORY_USER,
		computerId: computer.computerId,
		computerPolicy: "prefer_local" as const,
		requiredCapabilities: ["computer"],
	};
	this.queues.send("computer-starts", job);
	await deliverStartJob(this, job, state.driver);
});

Then("the answer is {int}", function (this: ChatticusWorld, status: number) {
	assert.equal(ownerServerOf(this).last.status, status, JSON.stringify(ownerServerOf(this).last.body));
});

Then("the answer is {int} with the code {string}", function (this: ChatticusWorld, status: number, code: string) {
	const { last } = ownerServerOf(this);
	assert.equal(last.status, status, JSON.stringify(last.body));
	assert.equal(last.body?.code, code, JSON.stringify(last.body));
	assert.equal(typeof last.body?.detail, "string");
});

Then("the answer is 401 or 403", function (this: ChatticusWorld) {
	assert.ok([401, 403].includes(ownerServerOf(this).last.status), String(ownerServerOf(this).last.status));
});

Then("the answer holds a supervisor token valid for {int} seconds and supervisor credentials", function (this: ChatticusWorld, seconds: number) {
	const { body } = ownerServerOf(this).bootstrapAnswers.find((answer) => answer.status === 200) ?? { body: null };
	assert.ok(body, "No bootstrap was answered 200.");
	const verification = verifyComputerOwnerToken(SCENARIO_GATEWAY_SIGNING_KEY, body.supervisor_token, this.clock.now());
	assert.ok(verification.valid, JSON.stringify(verification));
	assert.equal(verification.claims.expiresAtSeconds - verification.claims.issuedAtSeconds, seconds);
	assert.equal(body.supervisor_token_expires_at, new Date(verification.claims.expiresAtSeconds * 1000).toISOString());
	for (const field of ["access_key_id", "secret_access_key", "session_token", "expires_at"]) {
		assert.equal(typeof body.aws_credentials[field], "string", field);
	}
	assert.equal(body.computer_id, ownerServerOf(this).computerId);
});

Then("the supervisor token names the organization, the computer, the owner and generation {int} and no turn", function (this: ChatticusWorld, generation: number) {
	const scenario = ownerServerOf(this);
	const verification = verifyComputerOwnerToken(SCENARIO_GATEWAY_SIGNING_KEY, scenario.supervisorToken, this.clock.now());
	assert.ok(verification.valid, JSON.stringify(verification));
	assert.deepEqual(Object.keys(verification.claims).sort(), [
		"audience",
		"computerId",
		"expiresAtSeconds",
		"issuedAtSeconds",
		"ownerId",
		"startGeneration",
		"tenantId",
	]);
	assert.equal(verification.claims.tenantId, STORY_TENANT);
	assert.equal(verification.claims.computerId, scenario.computerId);
	assert.equal(verification.claims.ownerId, scenario.ownerId);
	assert.equal(verification.claims.startGeneration, generation);
});

Then("the computer records the owner, generation {int}, a start time and no dispatch", async function (this: ChatticusWorld, generation: number) {
	const scenario = ownerServerOf(this);
	const computer = await computerNow(this);
	assert.equal(computer.ownerId, scenario.ownerId);
	assert.equal(computer.ownerGeneration, generation);
	assert.equal(computer.ownerProtocolVersion, OWNER_PROTOCOL_VERSION);
	assert.ok(computer.ownerStartedAt, "No owner start time is recorded.");
	assert.equal(computer.dispatchId, undefined);
	assert.equal(computer.ownerStopApprovedAt, undefined);
});

Then("the computer records no owner", async function (this: ChatticusWorld) {
	const computer = await computerNow(this);
	assert.equal(computer.ownerId, undefined);
	assert.equal(computer.ownerGeneration, undefined);
});

Then("the broker was asked for supervisor credentials twice and the second answer was discarded", function (this: ChatticusWorld) {
	const calls = ownerBrokerOf(this).fake.calls.filter((call) => call.request.purpose === "supervisor");
	assert.equal(calls.length, 2);
	const [, second] = ownerServerOf(this).bootstrapAnswers;
	assert.equal(second?.status, 409);
	assert.equal(JSON.stringify(second?.body).includes("supervisor_token"), false);
	assert.equal(JSON.stringify(second?.body).includes("aws_credentials"), false);
});

Then("the owner is the live owner of the computer", async function (this: ChatticusWorld) {
	const live = await liveOwnerOfOrganization(STORY_TENANT, { store: this.messagingStore(), clock: this.clock, heartbeatTimeoutSeconds: this.heartbeatTimeoutSeconds });
	assert.equal(live?.ownerId, ownerServerOf(this).ownerId);
});

Then("the owner is not the live owner of the computer", async function (this: ChatticusWorld) {
	const live = await liveOwnerOfOrganization(STORY_TENANT, { store: this.messagingStore(), clock: this.clock, heartbeatTimeoutSeconds: this.heartbeatTimeoutSeconds });
	assert.equal(live, null);
});

Then("a turn that parks on the computer publishes a start job", async function (this: ChatticusWorld) {
	await parkTurnOf(this, "Analyst");
	assert.equal(queuedStartJobs(this).filter((job) => job.turnId === turnIdOfBot(this, "Analyst")).length, 1);
});

Then("the poll offered one dispatch with attempt {int}", function (this: ChatticusWorld, attempt: number) {
	const { dispatches } = lastPollOf(this);
	assert.equal(dispatches.length, 1);
	assert.equal(dispatches[0]!.attempt, attempt);
});

Then("the poll offered the same dispatch id with attempt {int}", function (this: ChatticusWorld, attempt: number) {
	const [first, second] = ownerServerOf(this).dispatches;
	assert.ok(first && second, "Two dispatches were not offered.");
	assert.equal(second.dispatch_id, first.dispatch_id);
	assert.equal(second.attempt, attempt);
	assert.equal(second.lease_expires_at, first.lease_expires_at);
	assert.equal(second.turn_id, first.turn_id);
});

Then("the dispatch id differs from the first", function (this: ChatticusWorld) {
	const [first, second] = ownerServerOf(this).dispatches;
	assert.ok(first && second, "Two dispatches were not offered.");
	assert.notEqual(second.dispatch_id, first.dispatch_id);
	assert.equal(second.turn_id, first.turn_id);
});

Then("the broker issued turn credentials twice for the one dispatch", function (this: ChatticusWorld) {
	assert.equal(ownerBrokerOf(this).fake.calls.filter((call) => call.request.purpose === "turn").length, 2);
	assert.equal(new Set(ownerServerOf(this).dispatches.map((dispatch) => dispatch.dispatch_id)).size, 1);
});

Then("the poll offered no dispatch", function (this: ChatticusWorld) {
	assert.deepEqual(lastPollOf(this).dispatches, []);
});

Then("the poll offered one dispatch for the turn of bot {string}", function (this: ChatticusWorld, botName: string) {
	const { dispatches } = lastPollOf(this);
	assert.equal(dispatches.length, 1);
	assert.equal(dispatches[0]!.turn_id, turnIdOfBot(this, botName));
});

Then("the dispatch names the turn, bot, channel, member and action", async function (this: ChatticusWorld) {
	const dispatch = ownerServerOf(this).dispatches.at(-1);
	assert.ok(dispatch, "No dispatch was offered.");
	const turn = await getTurn(this.turnDependencies(), STORY_TENANT, dispatch.turn_id);
	const [action] = await actionStoreOf(this).listForTurn(STORY_TENANT, turn.turnId);
	assert.equal(dispatch.bot_id, turn.botId);
	assert.equal(dispatch.channel_id, turn.channelId);
	assert.equal(dispatch.user_id, turn.promptAuthorId);
	assert.equal(dispatch.action_id, action?.actionId);
	assert.equal(dispatch.waiting_since, turn.waitingSince?.toISOString());
	assert.equal(dispatch.attempt, 1);
	assert.equal(dispatch.lease_expires_at, new Date((nowSeconds(this) + 30) * 1000).toISOString());
});

Then("the broker was asked for turn credentials with the five tags: tenant, bot, channel, computer and turn", async function (this: ChatticusWorld) {
	const dispatch = ownerServerOf(this).dispatches.at(-1);
	assert.ok(dispatch, "No dispatch was offered.");
	const call = ownerBrokerOf(this).fake.calls.filter((entry) => entry.request.purpose === "turn").at(-1);
	assert.ok(call, "The broker was not asked for turn credentials.");
	assert.deepEqual(
		call.tags,
		ownerSessionTags({ tenantId: STORY_TENANT, botId: dispatch.bot_id, channelId: dispatch.channel_id, computerId: ownerServerOf(this).computerId, turnId: dispatch.turn_id }),
	);
	assert.equal(call.request.authorization, ownerServerOf(this).supervisorToken);
	assert.deepEqual(
		supervisorSessionTags({ tenantId: STORY_TENANT, computerId: ownerServerOf(this).computerId }).map((tag) => tag.Key),
		["tenant", "computer"],
	);
});

Then("the dispatch holds a gateway token bound to the turn and the owner id", function (this: ChatticusWorld) {
	const dispatch = ownerServerOf(this).dispatches.at(-1);
	assert.ok(dispatch, "No dispatch was offered.");
	const verification = verifySessionToken(SCENARIO_GATEWAY_SIGNING_KEY, dispatch.gateway_token, this.clock.now(), "model-gateway");
	assert.ok(verification.valid, JSON.stringify(verification));
	assert.equal(verification.claims.turnId, dispatch.turn_id);
	assert.equal(verification.claims.botId, dispatch.bot_id);
	assert.equal(verification.claims.ownerId, ownerServerOf(this).ownerId);
	assert.equal(verification.claims.startGeneration, ownerServerOf(this).generation);
	assert.equal(new Date(verification.claims.expiresAtSeconds * 1000).toISOString(), dispatch.expires_at);
});

Then("the dispatch holds no host token", function (this: ChatticusWorld) {
	const dispatch = ownerServerOf(this).dispatches.at(-1);
	assert.ok(dispatch, "No dispatch was offered.");
	assert.deepEqual(Object.keys(dispatch).filter((key) => /host/i.test(key)), []);
	assert.deepEqual(
		Object.keys(dispatch).sort(),
		["action_id", "attempt", "aws_credentials", "bot_id", "channel_id", "dispatch_id", "expires_at", "gateway_token", "lease_expires_at", "turn_id", "user_id", "waiting_since"],
	);
});

Then("the action of the turn was answered as denied", async function (this: ChatticusWorld) {
	const [action] = await actionStoreOf(this).listForTurn(STORY_TENANT, turnIdOfBot(this, "Researcher"));
	assert.equal(action?.status, "done");
	assert.equal(action?.resultIsError, true);
	assert.ok(action?.result?.startsWith("denied:"), String(action?.result));
});

Then("the turn was resumed", async function (this: ChatticusWorld) {
	const turn = await getTurn(this.turnDependencies(), STORY_TENANT, turnIdOfBot(this, "Researcher"));
	assert.equal(turn.waitingFor, null);
});

Then("the poll asked the owner to poll again in {int} milliseconds", function (this: ChatticusWorld, milliseconds: number) {
	assert.equal(lastPollOf(this).next_poll_ms, milliseconds);
});

Then("the poll answered drain with reason {string} and no dispatch", function (this: ChatticusWorld, reason: string) {
	const answer = lastPollOf(this);
	assert.equal(answer.drain, true);
	assert.equal(answer.drain_reason, reason);
	assert.deepEqual(answer.dispatches, []);
});

Then("the owner's recorded state is still {string}", async function (this: ChatticusWorld, state: string) {
	const worker = await this.messagingStore().getWorker(STORY_TENANT, ownerServerOf(this).ownerId);
	assert.equal(worker?.pollState, state);
	assert.equal(worker?.pollSequence, 9);
});

Then("the stop was approved", function (this: ChatticusWorld) {
	assert.deepEqual(ownerServerOf(this).lastStop, { approved: true });
});

Then("the stop was not approved and the reason is {string}", function (this: ChatticusWorld, reason: string) {
	assert.deepEqual(ownerServerOf(this).lastStop, { approved: false, reason });
});

Then("exactly one of these holds", function (this: ChatticusWorld, table: DataTable) {
	const concurrent = ownerServerOf(this).concurrent;
	assert.ok(concurrent, "No stop request and poll were judged together.");
	const approved = concurrent.stop.body.approved === true;
	const offered = (concurrent.poll.body.dispatches as unknown[]).length === 1;
	const holds = table.raw().map(([sentence]) => {
		if (sentence === "the stop was approved and the poll offered no dispatch") return approved && !offered;
		if (sentence === "the stop was vetoed and the poll offered one dispatch") return !approved && offered;
		assert.fail(`Unknown alternative ${sentence}`);
	});
	assert.equal(holds.filter(Boolean).length, 1, JSON.stringify(concurrent));
});

Then("the start ended {string} for the owner and generation {int}", function (this: ChatticusWorld, kind: string, generation: number) {
	const state = computerScenarioOf(this);
	assert.equal(state.startError, null, state.startError?.message);
	assert.equal(state.startOutcome?.kind, kind);
	assert.deepEqual(state.startOutcome, { kind, hostStartGeneration: generation, ownerId: ownerServerOf(this).ownerId });
});

Then("the start ended {string} for generation {int}", function (this: ChatticusWorld, kind: string, generation: number) {
	const state = computerScenarioOf(this);
	assert.equal(state.startError, null, state.startError?.message);
	assert.deepEqual(state.startOutcome, { kind, hostStartGeneration: generation });
});

Then("the host start driver was not invoked", function (this: ChatticusWorld) {
	assert.equal(computerScenarioOf(this).driver?.invocations.length ?? 0, 0);
});

Then("the computer is still on host start generation {int}", async function (this: ChatticusWorld, generation: number) {
	assert.equal((await computerNow(this)).hostStartGeneration, generation);
});

Then("the computer is stopped and records no owner and no dispatch", async function (this: ChatticusWorld) {
	const computer = await computerNow(this);
	assert.equal(computer.stopped, true);
	for (const field of [
		"ownerId",
		"ownerProtocolVersion",
		"ownerStartedAt",
		"idleSinceAt",
		"ownerStopApprovedAt",
		"dispatchId",
		"dispatchTurnId",
		"dispatchActionId",
		"dispatchAttempt",
		"dispatchLeaseExpiresAt",
	] as const) {
		assert.equal(computer[field], undefined, field);
	}
});

Then("the computer still records generation {int} as the last owner generation", async function (this: ChatticusWorld, generation: number) {
	assert.equal((await computerNow(this)).ownerGeneration, generation);
});

Then("the computer's snapshot is unchanged", async function (this: ChatticusWorld) {
	const computer = await computerNow(this);
	assert.equal(computer.snapshotGeneration, 0);
	assert.equal(computer.snapshotUri, undefined);
});

