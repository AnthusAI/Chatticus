import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, InboxDoc, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { IndexedStorage } from "../../src/storage/indexed-storage.ts";
import { storageIdFor } from "../../src/storage/storage-support.ts";
import { modelScenarioOf, startBotTurn } from "../executor-harness.ts";
import { ensurePiStorage } from "../pi-storage.ts";
import type { ChatticusWorld } from "../world.ts";
import { currentTurnOf, readChannelMessages, readTurn, readTurnEvents } from "./model.steps.ts";

const wordsOfLength = (characters: number): string => {
	const words: string[] = [];
	for (let index = 1; words.join(" ").length < characters; index += 1) words.push(`w${String(index).padStart(4, "0")}`);
	return words.join(" ").slice(0, characters);
};

function watcherOf(world: ChatticusWorld) {
	const watcher = modelScenarioOf(world).watcher;
	assert.ok(watcher, "No one is watching the turn");
	return watcher;
}

function requestOf(world: ChatticusWorld, number: number): string {
	const request = modelScenarioOf(world).scripted.requests[number - 1];
	assert.ok(request, `The model was not asked ${number} times`);
	return request;
}

async function eventually(condition: () => Promise<boolean>, description: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!(await condition())) {
		assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

Given(
	"the model says {string} and calls the note tool with {string} and then answers {string}",
	function (this: ChatticusWorld, leadingText: string, note: string, answer: string) {
		modelScenarioOf(this).scripted.toolCall("note_to_channel", { note }, leadingText).reply(answer);
	},
);

Given(
	"the model calls the note tool with {string} and then answers {string}",
	function (this: ChatticusWorld, note: string, answer: string) {
		modelScenarioOf(this).scripted.toolCall("note_to_channel", { note }).reply(answer);
	},
);

Given("the model answers {string}", function (this: ChatticusWorld, answer: string) {
	modelScenarioOf(this).scripted.reply(answer);
});

Given("the model answers with a reply of {int} characters", function (this: ChatticusWorld, characters: number) {
	modelScenarioOf(this).scripted.reply(wordsOfLength(characters));
});

Given("the model holds its first request", function (this: ChatticusWorld) {
	modelScenarioOf(this).hold = modelScenarioOf(this).scripted.slow();
});

When("bot {string} starts a turn", function (this: ChatticusWorld, name: string) {
	modelScenarioOf(this).started = startBotTurn(this, name);
});

When("the model is waiting on its first request", async function (this: ChatticusWorld) {
	const hold = modelScenarioOf(this).hold;
	assert.ok(hold, "The model holds no request");
	await hold.reached;
});

When("the steered message has been taken into the conversation", async function (this: ChatticusWorld) {
	const channel = this.lastChannel;
	const bot = this.botsByName?.get("Assistant");
	assert.ok(channel && bot, "The scenario has no channel or bot");
	const piStorage = await ensurePiStorage(this);
	const storage = await IndexedStorage.open({
		client: this.messagingTable.client,
		s3: piStorage.s3,
		tableName: piStorage.tableName,
		bucket: piStorage.bucket,
		storageId: storageIdFor(channel.tenantId, bot.botId, channel.channelId),
	});
	await eventually(async () => {
		const inbox = await createSession(storage).snapshot(InboxDoc, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
		return (inbox?.items ?? []).some((item) => item.mode === "steer");
	}, "the steered message to be queued in the conversation");
});

When("the model is released", function (this: ChatticusWorld) {
	const hold = modelScenarioOf(this).hold;
	assert.ok(hold, "The model holds no request");
	hold.release();
});

When("the started turn finishes", async function (this: ChatticusWorld) {
	const scenario = modelScenarioOf(this);
	assert.ok(scenario.started, "No turn was started");
	scenario.lastOutcome = await scenario.started;
});

Then("the last post joined the turn remembered as {string}", function (this: ChatticusWorld, label: string) {
	assert.equal(currentTurnOf(this), this.rememberedTurnIds.get(label));
	assert.equal(modelScenarioOf(this).lastOutcome, "done");
});

Then("the model received {int} requests", function (this: ChatticusWorld, count: number) {
	assert.equal(modelScenarioOf(this).scripted.callCount, count);
});

Then("the model's request {int} included {string}", function (this: ChatticusWorld, number: number, text: string) {
	assert.ok(requestOf(this, number).includes(text), `Request ${number} did not include ${JSON.stringify(text)}`);
});

Then(
	"the model's request {int} included {string} before {string}",
	function (this: ChatticusWorld, number: number, first: string, second: string) {
		const request = requestOf(this, number);
		const firstAt = request.indexOf(first);
		const secondAt = request.indexOf(second);
		assert.ok(firstAt >= 0, `Request ${number} did not include ${JSON.stringify(first)}`);
		assert.ok(secondAt > firstAt, `Request ${number} did not include ${JSON.stringify(second)} after the first text`);
	},
);

Then("the channel has exactly one bot answer with body {string}", async function (this: ChatticusWorld, body: string) {
	const answers = (await readChannelMessages(this)).filter((message) => message.author_kind === "bot");
	assert.deepEqual(
		answers.map((message) => message.body),
		[body],
	);
});

Then("the channel has no bot answer", async function (this: ChatticusWorld) {
	const answers = (await readChannelMessages(this)).filter((message) => message.author_kind === "bot");
	assert.deepEqual(answers, []);
});

Then("the streamed text of the turn is {string}", async function (this: ChatticusWorld, text: string) {
	const watcher = watcherOf(this);
	await watcher.untilClosed();
	assert.equal(
		watcher.events
			.filter((event) => event.kind === "turn.token")
			.map((event) => event.payload.token)
			.join(""),
		text,
	);
});

Then(
	"the turn events show a call to tool {string} and its result before completion",
	async function (this: ChatticusWorld, tool: string) {
		const channel = this.lastChannel;
		assert.ok(channel, "No channel has been opened");
		const kinds = (await readTurnEvents(this, channel.tenantId, currentTurnOf(this))).map((event) => event.kind);
		const call = kinds.indexOf("tool.call");
		const result = kinds.indexOf("tool.result");
		assert.ok(call >= 0 && result > call && kinds.indexOf("turn.completed") > result, kinds.join(","));
		const events = await readTurnEvents(this, channel.tenantId, currentTurnOf(this));
		assert.equal(events[call]!.body, tool);
		assert.equal(events[call]!.action_id, events[result]!.action_id);
	},
);

Then("the completed event names the sequence of the bot answer", async function (this: ChatticusWorld) {
	const channel = this.lastChannel;
	assert.ok(channel, "No channel has been opened");
	const completed = (await readTurnEvents(this, channel.tenantId, currentTurnOf(this))).filter((event) => event.kind === "turn.completed");
	assert.equal(completed.length, 1);
	const answer = (await readChannelMessages(this)).find((message) => message.author_kind === "bot");
	assert.ok(answer, "The channel has no bot answer");
	assert.equal(completed[0]!.message_seq, answer.seq);
	assert.equal(completed[0]!.body, answer.body);
});

Then(
	"user {string} receives the whole reply as turn tokens in order",
	async function (this: ChatticusWorld, _userId: string) {
		const watcher = watcherOf(this);
		await watcher.untilClosed();
		const tokens = watcher.events.filter((event) => event.kind === "turn.token");
		assert.ok(tokens.length >= 1, "No turn tokens arrived");
		assert.deepEqual(
			tokens.map((event) => event.seq),
			[...tokens.map((event) => event.seq)].sort((left, right) => left - right),
		);
		assert.equal(tokens.map((event) => event.payload.token).join(""), wordsOfLength(600));
	},
);

Then("the turn events have integer sequences from 1 with no gaps", async function (this: ChatticusWorld) {
	const channel = this.lastChannel;
	assert.ok(channel, "No channel has been opened");
	const events = await readTurnEvents(this, channel.tenantId, currentTurnOf(this));
	assert.deepEqual(
		events.map((event) => event.seq),
		events.map((_event, index) => index + 1),
	);
	const watcher = watcherOf(this);
	await watcher.untilClosed();
	assert.deepEqual(
		watcher.events.map((event) => event.seq),
		events.map((event) => event.seq),
	);
});

Then("the last event of the turn is {string}", async function (this: ChatticusWorld, kind: string) {
	const channel = this.lastChannel;
	assert.ok(channel, "No channel has been opened");
	const events = await readTurnEvents(this, channel.tenantId, currentTurnOf(this));
	assert.equal(events[events.length - 1]!.kind, kind);
	const watcher = watcherOf(this);
	await watcher.untilClosed();
	assert.equal(watcher.events[watcher.events.length - 1]!.kind, kind);
});

When("the conversation store stops confirming writes", function (this: ChatticusWorld) {
	modelScenarioOf(this).storeFault.armed = true;
});

Then("the turn is reconciling", async function (this: ChatticusWorld) {
	const channel = this.lastChannel;
	assert.ok(channel, "No channel has been opened");
	assert.equal(modelScenarioOf(this).lastOutcome, "reconciling");
	const response = await readTurn(this, channel.tenantId, currentTurnOf(this));
	assert.equal(response.json.status, "reconciling");
});

Then("user {string} receives a reconciling server-sent event", async function (this: ChatticusWorld, _userId: string) {
	const watcher = watcherOf(this);
	await watcher.untilClosed();
	assert.equal(watcher.events[watcher.events.length - 1]!.kind, "turn.reconciling");
});
