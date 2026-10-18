import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { createBot } from "../../src/domain/bots.ts";
import { invokeTaskTool } from "../../src/domain/tasks.ts";
import { recordResponse, type RecordedResponse } from "../api.ts";
import { bearerFor } from "../front-door.ts";
import { ensureSignedInMember, ensureTestOrganization } from "../org-user-client.ts";
import type { ChatticusWorld } from "../world.ts";

type IdentityBindingScenario = {
	tenantId: string;
	channelId: string | null;
	botId: string | null;
	taskId: string | null;
	response: RecordedResponse | null;
};

const scenarios = new WeakMap<ChatticusWorld, IdentityBindingScenario>();

function scenarioOf(world: ChatticusWorld): IdentityBindingScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		scenario = { tenantId: "", channelId: null, botId: null, taskId: null, response: null };
		scenarios.set(world, scenario);
	}
	return scenario;
}

function memberOwnedChannelId(scenario: IdentityBindingScenario): string {
	assert.ok(scenario.channelId, "No channel has been opened");
	return scenario.channelId;
}

async function memberHeaders(world: ChatticusWorld, userId: string): Promise<Record<string, string>> {
	const scenario = scenarioOf(world);
	return bearerFor(world, await ensureSignedInMember(world, scenario.tenantId, userId));
}

async function callAsMember(
	world: ChatticusWorld,
	userId: string,
	method: "GET" | "POST" | "PATCH",
	path: string,
	body?: unknown,
): Promise<RecordedResponse> {
	assert.ok(world.api, "The scenario has no HTTP front door.");
	const url = `/orgs/${scenarioOf(world).tenantId}${path}`;
	const options = { headers: await memberHeaders(world, userId), ...(body === undefined ? {} : { body }) };
	const response =
		method === "GET" ? await world.api.get(url, options) : method === "POST" ? await world.api.post(url, options) : await world.api.patch(url, options);
	const recorded = await recordResponse(response);
	scenarioOf(world).response = recorded;
	return recorded;
}

Given("tenant {string} has the members {string} and {string}", async function (this: ChatticusWorld, tenantId: string, first: string, second: string) {
	scenarioOf(this).tenantId = tenantId;
	await ensureTestOrganization(this, tenantId);
	await ensureSignedInMember(this, tenantId, first);
	await ensureSignedInMember(this, tenantId, second);
});

Given(
	"user {string} of tenant {string} has a direct channel with bot {string}",
	async function (this: ChatticusWorld, userId: string, tenantId: string, botName: string) {
		const scenario = scenarioOf(this);
		const bot = await createBot(tenantId, botName, { creatorUserId: userId }, { store: this.messagingStore(), ids: this.ids });
		scenario.botId = bot.botId;
		const opened = await callAsMember(this, userId, "POST", "/channels", {
			user_id: userId,
			bot_ids: [bot.botId],
			kind: "direct",
			name: null,
		});
		assert.equal(opened.status, 200, opened.text);
		scenario.channelId = opened.json.channel_id;
	},
);

Given(
	"user {string} of tenant {string} has a task from bot {string}",
	async function (this: ChatticusWorld, userId: string, tenantId: string, _botName: string) {
		const scenario = scenarioOf(this);
		assert.ok(scenario.botId, "No bot has been created");
		const task = await invokeTaskTool(tenantId, userId, scenario.botId, "create", { title: "Pay the electric bill" }, {
			store: this.messagingStore(),
			ids: this.ids,
		});
		scenario.taskId = task.taskId;
	},
);

When(
	"member {string} posts {string} on the channel as human {string}",
	async function (this: ChatticusWorld, memberId: string, body: string, authorId: string) {
		await callAsMember(this, memberId, "POST", `/channels/${memberOwnedChannelId(scenarioOf(this))}/messages`, {
			author_kind: "human",
			author_id: authorId,
			body,
			addressed_to_bot_id: null,
		});
	},
);

When(
	"member {string} posts {string} on the channel as bot {string}",
	async function (this: ChatticusWorld, memberId: string, body: string, _botName: string) {
		const scenario = scenarioOf(this);
		await callAsMember(this, memberId, "POST", `/channels/${memberOwnedChannelId(scenario)}/messages`, {
			author_kind: "bot",
			author_id: scenario.botId,
			body,
			addressed_to_bot_id: null,
		});
	},
);

When("member {string} lists the messages of the channel", async function (this: ChatticusWorld, memberId: string) {
	await callAsMember(this, memberId, "GET", `/channels/${memberOwnedChannelId(scenarioOf(this))}/messages`);
});

When("member {string} reads the channel", async function (this: ChatticusWorld, memberId: string) {
	await callAsMember(this, memberId, "GET", `/channels/${memberOwnedChannelId(scenarioOf(this))}`);
});

When(
	"member {string} sends a voice line on the channel as user {string}",
	async function (this: ChatticusWorld, memberId: string, authorId: string) {
		const scenario = scenarioOf(this);
		await callAsMember(this, memberId, "POST", `/channels/${memberOwnedChannelId(scenario)}/voice-messages`, {
			author_id: authorId,
			addressed_to_bot_id: scenario.botId,
			transcript: "hello there",
		});
	},
);

When(
	"member {string} opens a direct channel for user {string} with bot {string}",
	async function (this: ChatticusWorld, memberId: string, userId: string, _botName: string) {
		await callAsMember(this, memberId, "POST", "/channels", {
			user_id: userId,
			bot_ids: [scenarioOf(this).botId],
			kind: "direct",
			name: null,
		});
	},
);

When("member {string} lists the channels of user {string}", async function (this: ChatticusWorld, memberId: string, userId: string) {
	await callAsMember(this, memberId, "GET", `/users/${userId}/channels`);
});

When("the organization owner lists the channels of user {string}", async function (this: ChatticusWorld, userId: string) {
	assert.ok(this.api, "The scenario has no HTTP front door.");
	const scenario = scenarioOf(this);
	const ownerEmail = await ensureTestOrganization(this, scenario.tenantId);
	scenario.response = await recordResponse(
		await this.api.get(`/orgs/${scenario.tenantId}/users/${userId}/channels`, { headers: await bearerFor(this, ownerEmail) }),
	);
});

When("member {string} creates a task for user {string}", async function (this: ChatticusWorld, memberId: string, userId: string) {
	await callAsMember(this, memberId, "POST", `/users/${userId}/tasks`, { bot_id: scenarioOf(this).botId, title: "Sneaky task" });
});

When("member {string} lists the tasks of user {string}", async function (this: ChatticusWorld, memberId: string, userId: string) {
	await callAsMember(this, memberId, "GET", `/users/${userId}/tasks`);
});

When("member {string} reads the task of user {string}", async function (this: ChatticusWorld, memberId: string, _userId: string) {
	await callAsMember(this, memberId, "GET", `/tasks/${scenarioOf(this).taskId}`);
});

When("member {string} closes the task of user {string}", async function (this: ChatticusWorld, memberId: string, _userId: string) {
	const scenario = scenarioOf(this);
	await callAsMember(this, memberId, "PATCH", `/tasks/${scenario.taskId}`, {
		bot_id: scenario.botId,
		action: "close",
		reason: "no longer needed",
	});
});

Then("the identity binding response status is {int}", function (this: ChatticusWorld, status: number) {
	const response = scenarioOf(this).response;
	assert.ok(response, "No response was recorded");
	assert.equal(response.status, status, response.text);
});
