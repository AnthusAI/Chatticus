import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { OWNER_CREDENTIAL_LIFETIME_SECONDS, type OwnerCredentialsResponse } from "@chatticus/host-protocol/supervisor";
import { claimTurn, failTurn, getTurn, renewTurn } from "../../src/domain/turns.ts";
import { ownerSessionTags } from "../../src/gateway/session-tags.ts";
import { verifyComputerOwnerToken, verifySessionToken, mintSessionToken } from "../../src/gateway/session-token.ts";
import { STORY_TENANT } from "../computer-scenario.ts";
import { startComputerOwner } from "../computer-owner.ts";
import { ownerBrokerOf } from "../owner-broker-support.ts";
import { SCENARIO_GATEWAY_SIGNING_KEY } from "../model-gateway-support.ts";
import type { ChatticusWorld } from "../world.ts";
import {
	capturedLogLinesOf,
	computerNow,
	hostPath,
	lastPollOf,
	mintBootstrap,
	mintSupervisor,
	nowSeconds,
	ownerServerOf,
	parkTurnOf,
	poll,
	send,
	type AnswerRecord,
} from "./owner-supervisor-server.steps.ts";

const OTHER_SIGNING_KEY = "a-different-signing-key-0123456789abcdef";

type RenewalScenario = {
	answers: AnswerRecord[];
	previousSupervisorToken: string | null;
	pendingRenewal: Promise<AnswerRecord> | null;
	releaseBroker: (() => void) | null;
	servedTurn: { turnId: string; dispatchId: string; botName: string; attemptId: string } | null;
	brokerCallsAtClaim: number;
	idleSinceAtSeconds: number | null;
};

const scenarios = new WeakMap<ChatticusWorld, RenewalScenario>();

function renewalOf(world: ChatticusWorld): RenewalScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		scenario = { answers: [], previousSupervisorToken: null, pendingRenewal: null, releaseBroker: null, servedTurn: null, brokerCallsAtClaim: 0, idleSinceAtSeconds: null };
		scenarios.set(world, scenario);
	}
	return scenario;
}

function supervisorRequestBody(world: ChatticusWorld, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const owner = ownerServerOf(world);
	return { kind: "supervisor", owner_id: owner.ownerId, generation: owner.generation, ...overrides };
}

function turnRequestBody(world: ChatticusWorld, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const owner = ownerServerOf(world);
	const served = renewalOf(world).servedTurn;
	assert.ok(served, "No turn was dispatched to the owner and claimed.");
	return { kind: "turn", owner_id: owner.ownerId, generation: owner.generation, dispatch_id: served.dispatchId, turn_id: served.turnId, ...overrides };
}

function remember(world: ChatticusWorld, answer: AnswerRecord): AnswerRecord {
	const scenario = renewalOf(world);
	scenario.answers.push(answer);
	if (answer.status === 200 && answer.body?.kind === "supervisor") {
		scenario.previousSupervisorToken = ownerServerOf(world).supervisorToken;
		ownerServerOf(world).supervisorToken = answer.body.supervisor_token;
	}
	return answer;
}

async function askForCredentials(world: ChatticusWorld, body: Record<string, unknown>, token?: string): Promise<AnswerRecord> {
	const scenario = renewalOf(world);
	const request = send(world, "POST", hostPath("/owner/credentials"), { token: token ?? ownerServerOf(world).supervisorToken, body });
	if (scenario.releaseBroker !== null) {
		const broker = ownerBrokerOf(world);
		const arrivalsBefore = broker.arrivals;
		scenario.pendingRenewal = request;
		for (let attempt = 0; attempt < 1000 && broker.arrivals === arrivalsBefore; attempt += 1) {
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		assert.ok(broker.arrivals > arrivalsBefore, "The renewal never reached the broker.");
		return { status: 0, body: null };
	}
	return remember(world, await request);
}

async function dispatchAndClaim(world: ChatticusWorld, botName: string): Promise<void> {
	const owner = ownerServerOf(world);
	const turnId = await parkTurnOf(world, botName);
	const answer = await poll(world, "idle");
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
	const dispatch = lastPollOf(world).dispatches[0];
	assert.ok(dispatch, "The poll offered no dispatch.");
	assert.equal(dispatch.turn_id, turnId);
	const bot = world.botsByName?.get(botName);
	assert.ok(bot, `No bot named ${botName}.`);
	const { held } = await startComputerOwner(world, `claimed-${botName}`, { hold: true, workerId: owner.ownerId, job: { tenantId: STORY_TENANT, turnId, botId: bot.botId } });
	assert.ok(held);
	await held.reached;
	const turn = await getTurn(world.turnDependencies(), STORY_TENANT, turnId);
	assert.ok(turn.attemptId, "The claimed turn has no attempt.");
	const scenario = renewalOf(world);
	scenario.servedTurn = { turnId, dispatchId: dispatch.dispatch_id, botName, attemptId: turn.attemptId };
	scenario.brokerCallsAtClaim = ownerBrokerOf(world).fake.calls.length;
}

const brokerCallsOf = (world: ChatticusWorld, purpose: string, afterIndex = 0) => ownerBrokerOf(world).fake.calls.slice(afterIndex).filter((call) => call.request.purpose === purpose);

When("the owner asks for new supervisor credentials", async function (this: ChatticusWorld) {
	await askForCredentials(this, supervisorRequestBody(this));
});

When("the owner asks for new supervisor credentials again {int} seconds later", async function (this: ChatticusWorld, seconds: number) {
	this.clock.advanceSeconds(seconds);
	await askForCredentials(this, supervisorRequestBody(this));
});

When("the owner asks for new supervisor credentials naming another owner id", async function (this: ChatticusWorld) {
	await askForCredentials(this, supervisorRequestBody(this, { owner_id: "owner-another" }));
});

When("the owner asks for new supervisor credentials twice at the same moment", async function (this: ChatticusWorld) {
	const token = ownerServerOf(this).supervisorToken;
	const body = supervisorRequestBody(this);
	const answers = await Promise.all([
		send(this, "POST", hostPath("/owner/credentials"), { token, body }),
		send(this, "POST", hostPath("/owner/credentials"), { token, body }),
	]);
	for (const answer of answers) renewalOf(this).answers.push(answer);
});

When(/^the owner asks for new supervisor credentials with a token that is (.+)$/, async function (this: ChatticusWorld, fault: string) {
	const owner = ownerServerOf(this);
	const faults: Record<string, () => Promise<string> | string> = {
		expired: () => mintSupervisor(this, { issuedAtSeconds: nowSeconds(this) - 4000, expiresAtSeconds: nowSeconds(this) - 1 }),
		"signed with another key": () => mintSupervisor(this, {}, OTHER_SIGNING_KEY),
		"a bootstrap token": () => mintBootstrap(this, {}),
		"a model gateway token": () =>
			mintSessionToken(SCENARIO_GATEWAY_SIGNING_KEY, {
				audience: "model-gateway",
				tenantId: STORY_TENANT,
				botId: "bot-1",
				turnId: "turn-1",
				ownerId: owner.ownerId,
				startGeneration: owner.generation,
				expiresAtSeconds: nowSeconds(this) + 300,
			}),
		"for another organization": () => mintSupervisor(this, { tenantId: "other-organization" }),
		"for generation 2 while generation 1 runs": () => mintSupervisor(this, { startGeneration: 2 }),
		"an owner that a newer owner replaced": async () => {
			const computer = await computerNow(this);
			await this.messagingStore().putComputer({ ...computer, ownerId: "owner-newer" });
			return owner.supervisorToken;
		},
	};
	const build = faults[fault];
	assert.ok(build, `Unknown token fault ${fault}`);
	await askForCredentials(this, supervisorRequestBody(this), await build());
});

When("the owner asks for new credentials for the dispatched turn", async function (this: ChatticusWorld) {
	await askForCredentials(this, turnRequestBody(this));
});

Given("the owner asked for new credentials for the dispatched turn", async function (this: ChatticusWorld) {
	const answer = await askForCredentials(this, turnRequestBody(this));
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
});

When("the owner asks for new credentials for the dispatched turn again {int} seconds later", async function (this: ChatticusWorld, seconds: number) {
	this.clock.advanceSeconds(seconds);
	await askForCredentials(this, turnRequestBody(this));
});

When("the owner asks for new credentials for that dispatch", async function (this: ChatticusWorld) {
	await askForCredentials(this, turnRequestBody(this));
});

When(/^the owner asks for new credentials for (a dispatch id that was never offered|a turn id other than the dispatched turn|the dispatched turn after it ended|the dispatched turn after another owner claimed it)$/, async function (this: ChatticusWorld, request: string) {
	const served = renewalOf(this).servedTurn;
	assert.ok(served, "No turn was dispatched to the owner and claimed.");
	const deps = this.turnDependencies();
	let body = turnRequestBody(this);
	if (request === "a dispatch id that was never offered") body = turnRequestBody(this, { dispatch_id: "dispatch-never-offered" });
	if (request === "a turn id other than the dispatched turn") body = turnRequestBody(this, { turn_id: "turn-another" });
	if (request === "the dispatched turn after it ended") await failTurn(deps, STORY_TENANT, served.turnId, served.attemptId, "The scenario ended the turn.");
	if (request === "the dispatched turn after another owner claimed it") {
		this.clock.advanceSeconds(61);
		const claim = await claimTurn(deps, STORY_TENANT, served.turnId, `attempt-of-another-owner-${this.ids.next()}`, "computer-owner-another");
		assert.ok(claim, "Another owner could not claim the turn after its lease ran out.");
	}
	await askForCredentials(this, body);
});

Given("a turn of bot {string} was dispatched to the owner and claimed", async function (this: ChatticusWorld, botName: string) {
	await dispatchAndClaim(this, botName);
});

When("a turn of bot {string} is dispatched to the owner and claimed {int} seconds later", async function (this: ChatticusWorld, botName: string, seconds: number) {
	this.clock.advanceSeconds(seconds);
	await dispatchAndClaim(this, botName);
});

When("the clock has moved {int} seconds past the dispatch", async function (this: ChatticusWorld, seconds: number) {
	const served = renewalOf(this).servedTurn;
	assert.ok(served, "No turn was dispatched to the owner and claimed.");
	this.clock.advanceSeconds(seconds);
	const renewed = await renewTurn(this.turnDependencies(), STORY_TENANT, served.turnId, served.attemptId);
	assert.ok(renewed, "The turn lease could not be renewed.");
});

When("the owner asks to stop with reason {string} and the stop is approved", async function (this: ChatticusWorld, reason: string) {
	const owner = ownerServerOf(this);
	const answer = await send(this, "POST", hostPath("/owner/stop-request"), {
		token: owner.supervisorToken,
		body: { owner_id: owner.ownerId, generation: owner.generation, reason, active_turns: [] },
	});
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
	assert.equal(answer.body.approved, true, JSON.stringify(answer.body));
});

Given("the broker holds its answer until released", function (this: ChatticusWorld) {
	renewalOf(this).releaseBroker = ownerBrokerOf(this).fake.holdNextCall();
});

Given("the broker refuses the next call because the owner's lifetime is over", function (this: ChatticusWorld) {
	ownerBrokerOf(this).fake.failNextCall("owner_lifetime_over");
});

When("the broker releases its answer", async function (this: ChatticusWorld) {
	const scenario = renewalOf(this);
	assert.ok(scenario.releaseBroker && scenario.pendingRenewal, "No renewal is waiting for the broker.");
	scenario.releaseBroker();
	scenario.releaseBroker = null;
	const answer = await scenario.pendingRenewal;
	scenario.pendingRenewal = null;
	scenario.answers.push(answer);
});

Given("the computer records when the owner became idle", async function (this: ChatticusWorld) {
	const computer = await computerNow(this);
	assert.ok(computer.idleSinceAt, "The computer records no idle start.");
	renewalOf(this).idleSinceAtSeconds = Math.floor(computer.idleSinceAt.getTime() / 1000);
});

Then("the second answer is {int} with the code {string}", function (this: ChatticusWorld, status: number, code: string) {
	const answer = renewalOf(this).answers[1];
	assert.ok(answer, "The owner has not been answered twice.");
	assert.equal(answer.status, status, JSON.stringify(answer.body));
	assert.equal(answer.body?.code, code, JSON.stringify(answer.body));
});

Then("the renewal answer is {int} with the code {string}", function (this: ChatticusWorld, status: number, code: string) {
	const answer = renewalOf(this).answers.at(-1);
	assert.ok(answer, "No renewal was answered.");
	assert.equal(answer.status, status, JSON.stringify(answer.body));
	assert.equal(answer.body?.code, code, JSON.stringify(answer.body));
});

Then("both answers are {int}", function (this: ChatticusWorld, status: number) {
	const answers = renewalOf(this).answers.slice(-2);
	assert.equal(answers.length, 2);
	for (const answer of answers) assert.equal(answer.status, status, JSON.stringify(answer.body));
});

Then("exactly one of the two answers is 200 and the other is 429 with the code {string}", function (this: ChatticusWorld, code: string) {
	const answers = renewalOf(this).answers.slice(-2);
	assert.deepEqual(answers.map((answer) => answer.status).sort(), [200, 429], JSON.stringify(answers));
	assert.equal(answers.find((answer) => answer.status === 429)?.body?.code, code);
});

Then("the broker was not asked for renewal credentials", function (this: ChatticusWorld) {
	assert.equal(brokerCallsOf(this, "supervisor_renewal").length, 0);
	assert.equal(brokerCallsOf(this, "turn", renewalOf(this).brokerCallsAtClaim).length, 0);
});

Then("the broker was not asked for turn credentials", function (this: ChatticusWorld) {
	assert.equal(brokerCallsOf(this, "turn", renewalOf(this).brokerCallsAtClaim).length, 0);
});

Then("the broker was asked for renewal credentials once", function (this: ChatticusWorld) {
	assert.equal(brokerCallsOf(this, "supervisor_renewal").length, 1);
});

Then("the answer holds a supervisor token valid for {int} seconds, a new set of supervisor credentials and no turn", function (this: ChatticusWorld, seconds: number) {
	const { last } = ownerServerOf(this);
	const body = last.body as Extract<OwnerCredentialsResponse, { kind: "supervisor" }>;
	assert.equal(body.kind, "supervisor");
	assert.deepEqual(Object.keys(body).sort(), ["aws_credentials", "kind", "supervisor_token", "supervisor_token_expires_at"]);
	assert.equal(Date.parse(body.supervisor_token_expires_at), (nowSeconds(this) + seconds) * 1000);
	assert.equal(Date.parse(body.aws_credentials.expires_at), (nowSeconds(this) + seconds) * 1000);
	assert.ok(body.aws_credentials.access_key_id.length > 0 && body.aws_credentials.secret_access_key.length > 0 && body.aws_credentials.session_token.length > 0);
	assert.equal(seconds, OWNER_CREDENTIAL_LIFETIME_SECONDS);
});

Then("the supervisor token keeps the owner's bootstrap time and names the same organization, computer, owner and generation", async function (this: ChatticusWorld) {
	const owner = ownerServerOf(this);
	const verification = verifyComputerOwnerToken(SCENARIO_GATEWAY_SIGNING_KEY, owner.supervisorToken, this.clock.now());
	assert.ok(verification.valid, JSON.stringify(verification));
	const computer = await computerNow(this);
	assert.ok(computer.ownerStartedAt);
	assert.equal(verification.claims.ownerStartedAtSeconds, Math.floor(computer.ownerStartedAt.getTime() / 1000));
	assert.equal(verification.claims.tenantId, STORY_TENANT);
	assert.equal(verification.claims.computerId, owner.computerId);
	assert.equal(verification.claims.ownerId, owner.ownerId);
	assert.equal(verification.claims.startGeneration, owner.generation);
});

Then("the broker was asked for supervisor renewal credentials with the owner's current supervisor token as the authorization", function (this: ChatticusWorld) {
	const calls = brokerCallsOf(this, "supervisor_renewal");
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.request.authorization, renewalOf(this).previousSupervisorToken);
});

Then("the computer records the new expiry of the owner's credentials", async function (this: ChatticusWorld) {
	const computer = await computerNow(this);
	assert.ok(computer.ownerStartedAt && computer.ownerCredentialsExpireAt && computer.ownerCredentialsRenewedAt);
	const granted = renewalOf(this).answers.find((answer) => answer.status === 200);
	assert.ok(granted, "No renewal was granted.");
	const expected = Math.min(Date.parse(granted.body.aws_credentials.expires_at), Date.parse(granted.body.supervisor_token_expires_at));
	assert.equal(computer.ownerCredentialsExpireAt.getTime(), expected);
	assert.ok(computer.ownerCredentialsExpireAt.getTime() > computer.ownerStartedAt.getTime() + OWNER_CREDENTIAL_LIFETIME_SECONDS * 1000);
});

Then("the computer still records the same owner and generation {int}", async function (this: ChatticusWorld, generation: number) {
	const computer = await computerNow(this);
	assert.equal(computer.ownerId, ownerServerOf(this).ownerId);
	assert.equal(computer.ownerGeneration, generation);
});

Then("the previous supervisor token still opens the poll route until it expires", async function (this: ChatticusWorld) {
	const previous = renewalOf(this).previousSupervisorToken;
	assert.ok(previous, "No supervisor token was replaced.");
	const answer = await poll(this, "idle", undefined, {}, previous);
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
});

Then("the answer holds a model gateway token bound to the turn, the bot and the owner id", function (this: ChatticusWorld) {
	const owner = ownerServerOf(this);
	const served = renewalOf(this).servedTurn;
	assert.ok(served);
	const body = owner.last.body as Extract<OwnerCredentialsResponse, { kind: "turn" }>;
	assert.equal(body.kind, "turn");
	assert.equal(body.dispatch_id, served.dispatchId);
	assert.equal(body.turn_id, served.turnId);
	const verification = verifySessionToken(SCENARIO_GATEWAY_SIGNING_KEY, body.gateway_token, this.clock.now(), "model-gateway");
	assert.ok(verification.valid, JSON.stringify(verification));
	assert.equal(verification.claims.turnId, served.turnId);
	assert.equal(verification.claims.botId, this.botsByName?.get(served.botName)?.botId);
	assert.equal(verification.claims.ownerId, owner.ownerId);
	assert.equal(verification.claims.startGeneration, owner.generation);
	assert.equal(new Date(verification.claims.expiresAtSeconds * 1000).toISOString(), body.expires_at);
});

Then("the answer holds credentials for a session tagged with the tenant, the bot, the channel, the computer and the turn", async function (this: ChatticusWorld) {
	const served = renewalOf(this).servedTurn;
	assert.ok(served);
	const turn = await getTurn(this.turnDependencies(), STORY_TENANT, served.turnId);
	const call = brokerCallsOf(this, "turn", renewalOf(this).brokerCallsAtClaim).at(-1);
	assert.ok(call, "The broker was not asked for turn credentials.");
	assert.deepEqual(call.tags, ownerSessionTags({ tenantId: STORY_TENANT, botId: turn.botId, channelId: turn.channelId, computerId: ownerServerOf(this).computerId, turnId: turn.turnId }));
	const body = ownerServerOf(this).last.body as Extract<OwnerCredentialsResponse, { kind: "turn" }>;
	assert.ok(body.aws_credentials.access_key_id.length > 0 && body.aws_credentials.session_token.length > 0);
});

Then("the broker was asked for turn credentials with the owner's supervisor token as the authorization", function (this: ChatticusWorld) {
	const call = brokerCallsOf(this, "turn", renewalOf(this).brokerCallsAtClaim).at(-1);
	assert.ok(call, "The broker was not asked for turn credentials.");
	assert.equal(call.request.authorization, ownerServerOf(this).supervisorToken);
});

Then("the computer still records the same idle start", async function (this: ChatticusWorld) {
	const computer = await computerNow(this);
	assert.ok(computer.idleSinceAt);
	assert.equal(Math.floor(computer.idleSinceAt.getTime() / 1000), renewalOf(this).idleSinceAtSeconds);
});

Then("no dispatch, stop approval or file operation was recorded", async function (this: ChatticusWorld) {
	const computer = await computerNow(this);
	assert.equal(computer.dispatchId, undefined);
	assert.equal(computer.ownerStopApprovedAt, undefined);
	assert.equal(computer.fileOperationId, undefined);
	assert.equal(computer.interactiveUntilAt, undefined);
});

Then("the control plane logged {string} for the owner with {string} and no token or credential", function (this: ChatticusWorld, event: string, field: string) {
	const owner = ownerServerOf(this);
	const lines = capturedLogLinesOf(this).filter((line) => line.startsWith(`${event} `) && line.includes(`owner_id=${owner.ownerId}`));
	assert.ok(lines.some((line) => line.includes(` ${field}`)), `No ${event} line with ${field}: ${lines.join(" | ")}`);
	const secrets = [owner.supervisorToken, renewalOf(this).previousSupervisorToken ?? "", "fake-secret", "fake-session", "ASIAFAKE", "gateway_token", "secret_access_key", "session_token"].filter((value) => value !== "");
	for (const line of capturedLogLinesOf(this)) {
		for (const secret of secrets) assert.equal(line.includes(secret), false, `A log line carries ${secret.slice(0, 12)}: ${line}`);
	}
});
