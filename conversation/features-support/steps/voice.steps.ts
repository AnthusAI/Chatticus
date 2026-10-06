import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { getVendorLedgerEntry } from "../../src/ledger/vendor-ledger.ts";
import { UNDERSTANDING_VENDOR } from "../../src/voice/understanding.ts";
import { recordResponse, type RecordedResponse } from "../api.ts";
import { ledgerDependenciesFor } from "../executor-harness.ts";
import { memberGet, memberPost } from "../org-user-client.ts";
import type { ChatticusWorld } from "../world.ts";
import { post } from "./message.steps.ts";

const UNDERSTANDING_MODEL = "gpt-5-nano";

function openChannelOf(world: ChatticusWorld): { channelId: string; tenantId: string } {
	assert.ok(world.lastChannel, "No channel has been opened");
	return world.lastChannel;
}

function botNamed(world: ChatticusWorld, name: string): { botId: string; name: string; tenantId: string } {
	const bot = world.botsByName?.get(name);
	assert.ok(bot, `Bot ${name} not found`);
	return bot;
}

async function channelMessages(world: ChatticusWorld): Promise<Array<Record<string, any>>> {
	const channel = openChannelOf(world);
	const response = await recordResponse(await memberGet(world, `/orgs/${channel.tenantId}/channels/${channel.channelId}/messages`));
	assert.equal(response.status, 200, response.text);
	return response.json.messages;
}

async function sayToBot(
	world: ChatticusWorld,
	tenantId: string,
	userId: string,
	transcript: string,
	botName: string,
	idempotencyKey?: string,
): Promise<RecordedResponse> {
	const channel = openChannelOf(world);
	const response = await recordResponse(
		await memberPost(
			world,
			`/orgs/${tenantId}/channels/${channel.channelId}/voice-messages`,
			{ author_id: userId, transcript, addressed_to_bot_id: botNamed(world, botName).botId },
			idempotencyKey === undefined ? {} : { "Idempotency-Key": idempotencyKey },
		),
	);
	world.voiceLineResponse = response;
	world.voiceLineResponses.push(response);
	return response;
}

function voiceLineResponseOf(world: ChatticusWorld): RecordedResponse {
	assert.ok(world.voiceLineResponse, "No voice line has been said");
	return world.voiceLineResponse;
}

function scriptedUsage(inputTokens: number, outputTokens: number) {
	return { vendor: UNDERSTANDING_VENDOR, model: UNDERSTANDING_MODEL, inputTokens, outputTokens };
}

Given(
	"the understand-the-user step hears {string} as {string}",
	function (this: ChatticusWorld, transcript: string, meaning: string) {
		this.scriptedUnderstanding.meanings.set(transcript, meaning);
	},
);

Given(
	"the understand-the-user step hears {string} as {string} using {int} input and {int} output tokens",
	function (this: ChatticusWorld, transcript: string, meaning: string, inputTokens: number, outputTokens: number) {
		this.scriptedUnderstanding.meanings.set(transcript, meaning);
		this.scriptedUnderstanding.usages.set(transcript, scriptedUsage(inputTokens, outputTokens));
	},
);

Given("the understand-the-user step finds no message in {string}", function (this: ChatticusWorld, transcript: string) {
	this.scriptedUnderstanding.meanings.set(transcript, "");
});

Given(
	"the understand-the-user step finds no message in {string} using {int} input and {int} output tokens",
	function (this: ChatticusWorld, transcript: string, inputTokens: number, outputTokens: number) {
		this.scriptedUnderstanding.meanings.set(transcript, "");
		this.scriptedUnderstanding.usages.set(transcript, scriptedUsage(inputTokens, outputTokens));
	},
);

Given("the understand-the-user step is unavailable", function (this: ChatticusWorld) {
	this.scriptedUnderstanding.unavailable = true;
});

Given("the channel already has {int} messages", async function (this: ChatticusWorld, count: number) {
	for (let index = 0; index < count; index += 1) {
		const response = await post(this, {
			authorKind: "human",
			authorId: "ryan",
			body: `Earlier line ${index + 1}.`,
			addressedToBotId: null,
			enqueueTurn: false,
		});
		assert.equal(response.status, 200, response.text);
	}
});

When(
	"user {string} of tenant {string} says {string} to bot {string} on the channel",
	async function (this: ChatticusWorld, userId: string, tenantId: string, transcript: string, botName: string) {
		this.messageCountBeforeVoiceLine = (await channelMessages(this)).length;
		const response = await sayToBot(this, tenantId, userId, transcript, botName);
		assert.equal(response.status, 200, response.text);
		this.lastTurnId = response.json.turn_id;
	},
);

When(
	"user {string} of tenant {string} says {string} to bot {string} on the channel with idempotency key {string}",
	async function (this: ChatticusWorld, userId: string, tenantId: string, transcript: string, botName: string, key: string) {
		const response = await sayToBot(this, tenantId, userId, transcript, botName, key);
		assert.equal(response.status, 200, response.text);
	},
);

Then("the first voice line was degraded", function (this: ChatticusWorld) {
	assert.equal(this.voiceLineResponses[0]?.json.degraded, true, this.voiceLineResponses[0]?.text);
});

Then("the replayed voice line has the same message and turn and is not degraded", function (this: ChatticusWorld) {
	const [first, replay] = this.voiceLineResponses;
	assert.ok(first && replay, "The line was not said twice");
	assert.equal(replay.json.degraded, false, replay.text);
	assert.equal(replay.json.message.message_id, first.json.message.message_id);
	assert.equal(replay.json.turn_id, first.json.turn_id);
	assert.equal(replay.json.understood, first.json.message.body);
});

Then("the understand-the-user step was asked {int} times", function (this: ChatticusWorld, count: number) {
	assert.equal(this.scriptedUnderstanding.calls.length, count);
});

When(
	"user {string} of tenant {string} tries to say {string} to bot {string} on the channel",
	async function (this: ChatticusWorld, userId: string, tenantId: string, transcript: string, botName: string) {
		await sayToBot(this, tenantId, userId, transcript, botName);
	},
);

When(
	"user {string} of tenant {string} tries to say a {int}-character line to bot {string} on the channel",
	async function (this: ChatticusWorld, userId: string, tenantId: string, length: number, botName: string) {
		await sayToBot(this, tenantId, userId, "a".repeat(length), botName);
	},
);

Then(
	"the latest message on the channel is {string} from user {string}",
	async function (this: ChatticusWorld, body: string, userId: string) {
		const latest = (await channelMessages(this)).at(-1);
		assert.ok(latest, "The channel has no messages");
		assert.equal(latest.body, body);
		assert.equal(latest.author_id, userId);
	},
);

Then("that message starts a turn for bot {string}", async function (this: ChatticusWorld, botName: string) {
	const turnId = voiceLineResponseOf(this).json.turn_id;
	assert.ok(turnId, voiceLineResponseOf(this).text);
	const channel = openChannelOf(this);
	const turn = await recordResponse(await memberGet(this, `/orgs/${channel.tenantId}/turns/${turnId}`));
	assert.equal(turn.status, 200, turn.text);
	assert.equal(turn.json.bot_id, botNamed(this, botName).botId);
});

Then("the understand-the-user step was given {string} as recent conversation", function (this: ChatticusWorld, body: string) {
	const call = this.scriptedUnderstanding.calls.at(-1);
	assert.ok(call, "The understand-the-user step was not asked");
	assert.ok(
		call.recent.some((line) => line.text === body),
		JSON.stringify(call.recent),
	);
});

Then("the understand-the-user step was given {int} recent messages", function (this: ChatticusWorld, count: number) {
	const call = this.scriptedUnderstanding.calls.at(-1);
	assert.ok(call, "The understand-the-user step was not asked");
	assert.equal(call.recent.length, count);
});

Then("no message is posted for that line", async function (this: ChatticusWorld) {
	assert.equal((await channelMessages(this)).length, this.messageCountBeforeVoiceLine);
	assert.equal(voiceLineResponseOf(this).json.message, null);
});

Then("no turn starts for that line", function (this: ChatticusWorld) {
	assert.equal(voiceLineResponseOf(this).json.turn_id, null);
});

Then("the voice line is refused as forbidden", function (this: ChatticusWorld) {
	assert.equal(voiceLineResponseOf(this).status, 403, voiceLineResponseOf(this).text);
});

Then("the voice line is refused as invalid", function (this: ChatticusWorld) {
	assert.equal(voiceLineResponseOf(this).status, 422, voiceLineResponseOf(this).text);
});

Then("the understand-the-user step was not asked", function (this: ChatticusWorld) {
	assert.deepEqual(this.scriptedUnderstanding.calls, []);
});

Then(
	"the organization has a voice understanding spend entry of {int} input and {int} output tokens",
	async function (this: ChatticusWorld, inputTokens: number, outputTokens: number) {
		const channel = openChannelOf(this);
		const voiceRows = (await this.store.listVendorLedgerRowsForTenant(channel.tenantId)).filter((row) => row.turnId.startsWith("voice:"));
		assert.equal(voiceRows.length, 1, JSON.stringify(voiceRows));
		const entry = await getVendorLedgerEntry(ledgerDependenciesFor(this), channel.tenantId, voiceRows[0]!.turnId);
		assert.ok(entry, "The voice spend row is not readable");
		assert.equal(entry.inputTokens, inputTokens);
		assert.equal(entry.outputTokens, outputTokens);
		assert.equal(entry.vendor, UNDERSTANDING_VENDOR);
	},
);

Then("the turn for that message has no spend from the understanding call", async function (this: ChatticusWorld) {
	const channel = openChannelOf(this);
	const turnId = voiceLineResponseOf(this).json.turn_id;
	assert.ok(turnId, voiceLineResponseOf(this).text);
	assert.equal(await getVendorLedgerEntry(ledgerDependenciesFor(this), channel.tenantId, turnId), null);
});
