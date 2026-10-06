import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { recordResponse, type RecordedResponse } from "../api.ts";
import { DEFAULT_SCRIPTED_ANSWER_PATTERN, modelScenarioOf, runBotTurn } from "../executor-harness.ts";
import { TURN_RUN_QUEUE } from "../front-door.ts";
import { memberGet } from "../org-user-client.ts";
import { TurnWatcher } from "../turn-watcher.ts";
import type { TurnRunJob } from "../../src/domain/turn-admission.ts";
import type { ChatticusWorld } from "../world.ts";
import { post } from "./message.steps.ts";

function openChannelOf(world: ChatticusWorld): { channelId: string; tenantId: string } {
	assert.ok(world.lastChannel, "No channel has been opened");
	return world.lastChannel;
}

/** The turn the scenario's last post started or joined. */
export function currentTurnOf(world: ChatticusWorld): string {
	assert.ok(world.lastTurnId, "The last post started no turn");
	return world.lastTurnId;
}

/** Read one turn through the HTTP API. */
export async function readTurn(world: ChatticusWorld, tenantId: string, turnId: string): Promise<RecordedResponse> {
	return recordResponse(await memberGet(world, `/orgs/${tenantId}/turns/${turnId}`));
}

/** Read a turn's durable events through the HTTP API. */
export async function readTurnEvents(world: ChatticusWorld, tenantId: string, turnId: string): Promise<Array<Record<string, any>>> {
	const response = await recordResponse(await memberGet(world, `/orgs/${tenantId}/turns/${turnId}/events`));
	assert.equal(response.status, 200, response.text);
	return response.json.events;
}

/** Read the channel's messages through the HTTP API. */
export async function readChannelMessages(world: ChatticusWorld): Promise<Array<Record<string, any>>> {
	const channel = openChannelOf(world);
	const response = await recordResponse(await memberGet(world, `/orgs/${channel.tenantId}/channels/${channel.channelId}/messages`));
	assert.equal(response.status, 200, response.text);
	return response.json.messages;
}

Given(
	"the model provider answers every request with status {int} and error code {string}",
	function (this: ChatticusWorld, status: number, code: string) {
		modelScenarioOf(this).scripted.alwaysProviderError(status, code);
	},
);

Given(
	"the model provider answers every request with status {int} and no error body",
	function (this: ChatticusWorld, status: number) {
		modelScenarioOf(this).scripted.alwaysProviderError(status, null);
	},
);

Given(
	"user {string} of tenant {string} is watching that turn through server-sent events",
	async function (this: ChatticusWorld, _userId: string, tenantId: string) {
		modelScenarioOf(this).watcher = await TurnWatcher.open(this, tenantId, currentTurnOf(this));
	},
);

When("bot {string} runs one computerless worker turn against that provider", async function (this: ChatticusWorld, name: string) {
	await runBotTurn(this, name);
});

When("bot {string} completes one turn", async function (this: ChatticusWorld, name: string) {
	assert.equal(await runBotTurn(this, name), "done");
});

Then("the turn has failed with reason {string}", async function (this: ChatticusWorld, reason: string) {
	const channel = openChannelOf(this);
	const response = await readTurn(this, channel.tenantId, currentTurnOf(this));
	assert.equal(response.status, 200, response.text);
	assert.equal(response.json.status, "failed");
	assert.equal(response.json.terminal_reason, reason);
});

Then(
	"user {string} receives a failed server-sent event with reason {string}",
	async function (this: ChatticusWorld, _userId: string, reason: string) {
		const watcher = modelScenarioOf(this).watcher;
		assert.ok(watcher, "No one is watching the turn");
		await watcher.untilClosed();
		const failed = watcher.events.filter((event) => event.kind === "turn.failed");
		assert.equal(failed.length, 1);
		assert.equal(failed[0]!.payload.body, reason);
		assert.equal(watcher.events[watcher.events.length - 1]!.kind, "turn.failed");
	},
);

Then("the model provider was called once", function (this: ChatticusWorld) {
	assert.equal(modelScenarioOf(this).scripted.callCount, 1);
});

Then("the model provider was retried before the turn failed", function (this: ChatticusWorld) {
	assert.ok(modelScenarioOf(this).scripted.callCount > 1, "The provider was called only once");
});

Then("no job for bot {string} is left to retry", function (this: ChatticusWorld, name: string) {
	const bot = this.botsByName?.get(name);
	assert.ok(bot, `Bot ${name} not found`);
	const left = this.queues
		.pending(TURN_RUN_QUEUE)
		.map((queued) => queued.body as TurnRunJob)
		.filter((job) => job.botId === bot.botId);
	assert.deepEqual(left, []);
});

When(
	"user {string} of tenant {string} posts a text-only message addressed to bot {string} on the channel",
	async function (this: ChatticusWorld, userId: string, tenantId: string, name: string) {
		const bot = this.botsByName?.get(name);
		assert.ok(bot, `Bot ${name} not found`);
		const response = await post(this, {
			authorKind: "human",
			authorId: userId,
			body: "what time is it?",
			addressedToBotId: bot.botId,
			tenantId,
		});
		assert.equal(response.status, 200, response.text);
	},
);

Then("the channel contains one durable bot answer", async function (this: ChatticusWorld) {
	const answers = (await readChannelMessages(this)).filter((message) => message.author_kind === "bot");
	assert.equal(answers.length, 1);
	assert.match(answers[0]!.body, DEFAULT_SCRIPTED_ANSWER_PATTERN);
});

Then("the latest bot message body equals the joined chunks for the active turn", async function (this: ChatticusWorld) {
	const channel = openChannelOf(this);
	const chunks = (await readTurnEvents(this, channel.tenantId, currentTurnOf(this)))
		.filter((event) => event.kind === "turn.token")
		.map((event) => event.token);
	assert.ok(chunks.length > 0, "The turn streamed no text");
	const answers = (await readChannelMessages(this)).filter((message) => message.author_kind === "bot");
	assert.equal(answers[answers.length - 1]!.body, chunks.join(""));
});
