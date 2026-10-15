import assert from "node:assert/strict";
import { Given, Then, When, type DataTable } from "@cucumber/cucumber";
import { createBot, DuplicateBotNameError, rememberBotMemory } from "../../src/domain/bots.ts";
import { recordResponse } from "../api.ts";
import { memberGet } from "../org-user-client.ts";
import type { ChatticusWorld } from "../world.ts";
import { resetScenarioToEmptyControlPlane } from "./bot.steps.ts";

function botNamed(world: ChatticusWorld, name: string): { botId: string; name: string; tenantId: string } {
	const bot = world.botsByName?.get(name);
	assert.ok(bot, `Bot ${name} not found`);
	return bot;
}

function recycleControlPlane(world: ChatticusWorld): void {
	world.scenarioMessagingStore = world.createMessagingStore();
}

async function createNamedBot(
	world: ChatticusWorld,
	tenantId: string,
	userId: string,
	name: string,
	idempotencyKey: string | null,
): Promise<void> {
	try {
		const bot = await createBot(
			tenantId,
			name,
			{ creatorUserId: userId, idempotencyKey },
			{ store: world.messagingStore(), ids: world.ids },
		);
		world.botsByName?.set(name, bot);
		world.botsById?.set(bot.botId, bot);
		world.lastError = null;
		if (idempotencyKey !== null) {
			world.createdBotIds.push(bot.botId);
		}
	} catch (error) {
		assert.ok(error instanceof Error);
		world.lastError = error;
	}
}

Given("an empty control plane backed by a durable messaging store", async function (this: ChatticusWorld) {
	await resetScenarioToEmptyControlPlane(this);
});

When(
	"I create a bot named {string} for tenant {string} user {string}",
	async function (this: ChatticusWorld, name: string, tenantId: string, userId: string) {
		await createNamedBot(this, tenantId, userId, name, null);
	},
);

When(
	"a new control plane instance creates a bot named {string} for tenant {string} user {string}",
	async function (this: ChatticusWorld, name: string, tenantId: string, userId: string) {
		recycleControlPlane(this);
		await createNamedBot(this, tenantId, userId, name, null);
	},
);

When(
	"tenant {string} user {string} creates bot {string} using idempotency key {string}",
	async function (this: ChatticusWorld, tenantId: string, userId: string, name: string, key: string) {
		await createNamedBot(this, tenantId, userId, name, key);
		assert.equal(this.lastError, null);
	},
);

When(
	"a recycled control plane creates bot {string} for tenant {string} user {string} using idempotency key {string}",
	async function (this: ChatticusWorld, name: string, tenantId: string, userId: string, key: string) {
		recycleControlPlane(this);
		await createNamedBot(this, tenantId, userId, name, key);
		assert.equal(this.lastError, null);
	},
);

Then("creating the bot fails because the name is already used", function (this: ChatticusWorld) {
	assert.ok(this.lastError instanceof DuplicateBotNameError, String(this.lastError));
});

Then("the created bot identifier is unchanged", function (this: ChatticusWorld) {
	assert.equal(this.createdBotIds.length, 2);
	assert.equal(this.createdBotIds[1], this.createdBotIds[0]);
});

When(
	"bot {string} remembers {string} as {string}",
	async function (this: ChatticusWorld, name: string, key: string, value: string) {
		const bot = botNamed(this, name);
		await rememberBotMemory(bot.tenantId, bot.botId, key, value, { store: this.messagingStore() });
	},
);

Then(
	"tenant {string} can look up bot {string} for user {string}",
	async function (this: ChatticusWorld, tenantId: string, name: string, _userId: string) {
		const expected = botNamed(this, name);
		const response = await recordResponse(await memberGet(this, `/orgs/${tenantId}/bots?name=${encodeURIComponent(name)}`));
		assert.equal(response.status, 200, response.text);
		assert.equal(response.json.bot_id, expected.botId);
		assert.equal(response.json.name, name);
	},
);

Then(
	"tenant {string} can list bots for user {string}:",
	async function (this: ChatticusWorld, tenantId: string, userId: string, table: DataTable) {
		const expectedNames = table
			.raw()
			.map((row) => (row[0] ?? "").trim())
			.filter((name) => name !== "");
		const response = await recordResponse(await memberGet(this, `/orgs/${tenantId}/users/${userId}/bots`));
		assert.equal(response.status, 200, response.text);
		assert.deepEqual(
			response.json.bots.map((bot: { name: string }) => bot.name),
			expectedNames,
		);
		for (const name of expectedNames) {
			const listed = response.json.bots.find((bot: { name: string }) => bot.name === name);
			assert.equal(listed.bot_id, botNamed(this, name).botId);
		}
	},
);

Then(
	"tenant {string} can read bot {string} by identifier with memory {string} as {string}",
	async function (this: ChatticusWorld, tenantId: string, name: string, key: string, value: string) {
		const expected = botNamed(this, name);
		const response = await recordResponse(await memberGet(this, `/orgs/${tenantId}/bots/${expected.botId}`));
		assert.equal(response.status, 200, response.text);
		assert.equal(response.json.bot_id, expected.botId);
		assert.equal(response.json.name, name);
		assert.equal(response.json.memory[key], value);
		const missing = await recordResponse(await memberGet(this, `/orgs/other/bots/${expected.botId}`));
		assert.equal(missing.status, 404, missing.text);
	},
);
