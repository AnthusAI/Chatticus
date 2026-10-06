import assert from "node:assert/strict";
import { Then, When } from "@cucumber/cucumber";
import { HttpClient, type TurnWatchOutcome } from "../../src/acceptance/http-client.ts";
import { startBotTurn } from "../executor-harness.ts";
import { recordResponse } from "../api.ts";
import { httpBaseUrl } from "../front-door.ts";
import { memberGet, organizationMemberHeaders } from "../org-user-client.ts";
import type { ChatticusWorld } from "../world.ts";

const DEMO_BOT = "Assistant";

type DemoScenario = {
	client: HttpClient | null;
	outcome: TurnWatchOutcome | null;
	run: ReturnType<typeof startBotTurn> | null;
};

const scenarios = new WeakMap<ChatticusWorld, DemoScenario>();

function demoOf(world: ChatticusWorld): DemoScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		scenario = { client: null, outcome: null, run: null };
		scenarios.set(world, scenario);
	}
	return scenario;
}

function channelOf(world: ChatticusWorld): { channelId: string; tenantId: string } {
	assert.ok(world.lastChannel, "The scenario has no open channel.");
	return world.lastChannel;
}

function turnIdOf(world: ChatticusWorld): string {
	assert.ok(world.lastTurnId, "The channel has no turn.");
	return world.lastTurnId;
}

async function demoClientOf(world: ChatticusWorld): Promise<HttpClient> {
	const scenario = demoOf(world);
	if (scenario.client === null) {
		const { tenantId } = channelOf(world);
		scenario.client = new HttpClient({
			baseUrl: await httpBaseUrl(world),
			headers: await organizationMemberHeaders(world, `/orgs/${tenantId}/turns/${turnIdOf(world)}/stream`),
		});
	}
	return scenario.client;
}

function outcomeOf(world: ChatticusWorld): TurnWatchOutcome {
	const outcome = demoOf(world).outcome;
	assert.ok(outcome, "The demo client has watched no turn.");
	return outcome;
}

async function finishWorkerRun(world: ChatticusWorld): Promise<void> {
	const run = demoOf(world).run;
	assert.ok(run, "No worker run was started.");
	assert.equal(await run, "done");
}

When("the demo client watches the turn stream for that channel", async function (this: ChatticusWorld) {
	const client = await demoClientOf(this);
	demoOf(this).run = startBotTurn(this, DEMO_BOT);
	demoOf(this).outcome = await client.streamTurnEvents(turnIdOf(this), `/orgs/${channelOf(this).tenantId}`);
	await finishWorkerRun(this);
});

When("the demo client watches the turn stream until one token arrives then drops", async function (this: ChatticusWorld) {
	const client = await demoClientOf(this);
	demoOf(this).run = startBotTurn(this, DEMO_BOT);
	demoOf(this).outcome = await client.streamTurnEvents(turnIdOf(this), `/orgs/${channelOf(this).tenantId}`, undefined, 1);
	await finishWorkerRun(this);
});

When("the demo client reconnects to the same turn from stored chunks", async function (this: ChatticusWorld) {
	const client = await demoClientOf(this);
	const first = outcomeOf(this);
	const resumed = await client.streamTurnEvents(
		turnIdOf(this),
		`/orgs/${channelOf(this).tenantId}`,
		undefined,
		undefined,
		120,
		first.lastSeq,
	);
	demoOf(this).outcome = {
		events: [...first.events, ...resumed.events],
		tokens: [...first.tokens, ...resumed.tokens],
		committedBody: resumed.committedBody ?? first.committedBody,
		lastSeq: Math.max(first.lastSeq, resumed.lastSeq),
	};
});

Then("the demo client saw turn tokens in order", function (this: ChatticusWorld) {
	const outcome = outcomeOf(this);
	const tokenEvents = outcome.events.filter((event) => event.kind === "turn.token");
	assert.ok(tokenEvents.length > 0, "The demo client saw no token.");
	assert.deepEqual(
		outcome.tokens,
		tokenEvents.map((event) => event.token),
	);
	const sequences = tokenEvents.map((event) => Number(event.seq));
	assert.deepEqual(sequences, [...sequences].sort((left, right) => left - right));
});

Then("the demo client saw the committed bot reply", function (this: ChatticusWorld) {
	const outcome = outcomeOf(this);
	assert.ok(outcome.committedBody !== null && outcome.committedBody.trim() !== "", "No committed reply was seen.");
	const completed = outcome.events.filter((event) => event.kind === "turn.completed");
	assert.equal(completed.length, 1);
	assert.equal(completed[0]!.body, outcome.committedBody);
});

Then("the committed bot reply matches the streamed tokens", function (this: ChatticusWorld) {
	const outcome = outcomeOf(this);
	const streamed = outcome.tokens.join("");
	assert.equal(outcome.committedBody, streamed);
	const completed = outcome.events.filter((event) => event.kind === "turn.completed");
	assert.equal(completed.length, 1);
	assert.equal(completed[0]!.body, streamed);
});

Then("the committed bot reply is not the prior bot greeting on the channel", async function (this: ChatticusWorld) {
	const outcome = outcomeOf(this);
	const { tenantId, channelId } = channelOf(this);
	const response = await recordResponse(await memberGet(this, `/orgs/${tenantId}/channels/${channelId}/messages`));
	assert.equal(response.status, 200, response.text);
	const botMessages = (response.json.messages as Array<{ author_kind: string; body: string }>).filter(
		(message) => message.author_kind === "bot",
	);
	assert.ok(botMessages.length >= 2, "The channel holds fewer than two bot replies.");
	assert.notEqual(outcome.committedBody, botMessages[0]!.body);
});

Then("the demo client saw turn tokens in order without duplicate sequences", function (this: ChatticusWorld) {
	const outcome = outcomeOf(this);
	const sequences = outcome.events.map((event) => Number(event.seq));
	assert.equal(new Set(sequences).size, sequences.length);
	const tokenSequences = outcome.events.filter((event) => event.kind === "turn.token").map((event) => Number(event.seq));
	assert.ok(tokenSequences.length > 0, "The demo client saw no token.");
	assert.deepEqual(tokenSequences, [...tokenSequences].sort((left, right) => left - right));
});
