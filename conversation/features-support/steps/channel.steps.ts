import assert from "node:assert/strict";
import { Given, Then, When, type DataTable } from "@cucumber/cucumber";
import type { Channel } from "../../src/domain/channels.ts";
import { recordResponse } from "../api.ts";
import { wireFrontDoor } from "../front-door.ts";
import { memberGet, memberPost } from "../org-user-client.ts";
import type { ChatticusWorld } from "../world.ts";

function orgPath(tenantId: string, path: string): string {
	return `/orgs/${tenantId}${path}`;
}

function namesFromTable(table: DataTable): string[] {
	return table
		.raw()
		.map((row) => (row[0] ?? "").trim())
		.filter((name) => name !== "");
}

function botIdsFor(world: ChatticusWorld, names: string[]): string[] {
	return names.map((name) => {
		const bot = world.botsByName?.get(name);
		assert.ok(bot, `Bot ${name} not found`);
		return bot.botId;
	});
}

async function openChannel(
	world: ChatticusWorld,
	tenantId: string,
	userId: string,
	kind: "direct" | "named",
	botNames: string[],
	name: string | null,
	headers: Record<string, string> = {},
): Promise<Record<string, any>> {
	const response = await memberPost(
		world,
		orgPath(tenantId, "/channels"),
		{ user_id: userId, kind, name, bot_ids: botIdsFor(world, botNames) },
		headers,
	);
	const recorded = await recordResponse(response);
	assert.equal(recorded.status, 200, recorded.text);
	return recorded.json;
}

When(
	"tenant {string} user {string} opens a direct channel with bot {string}",
	async function (this: ChatticusWorld, tenantId: string, userId: string, botName: string) {
		this.directChannelPayloads = [
			...this.directChannelPayloads,
			await openChannel(this, tenantId, userId, "direct", [botName], null),
		];
	},
);

When(
	"tenant {string} user {string} creates named channel {string} with bots:",
	async function (this: ChatticusWorld, tenantId: string, userId: string, channelName: string, table: DataTable) {
		this.namedChannelPayload = await openChannel(this, tenantId, userId, "named", namesFromTable(table), channelName);
	},
);

When("a recycled Front Door serves the same messaging store", async function (this: ChatticusWorld) {
	await wireFrontDoor(this, { signupMode: "invitation_only", cognitoVerifier: true });
});

Then("both direct channel opens return the same channel identifier", function (this: ChatticusWorld) {
	assert.equal(this.directChannelPayloads.length, 2);
	assert.equal(this.directChannelPayloads[0]!.channel_id, this.directChannelPayloads[1]!.channel_id);
});

Given(
	"a canonical direct channel already exists under identifier {string}",
	async function (this: ChatticusWorld, channelId: string) {
		const researcher = this.botsByName?.get("Researcher");
		assert.ok(researcher, "Bot Researcher not found");
		const channel: Channel = {
			channelId,
			tenantId: "anthus",
			kind: "direct",
			name: null,
			participants: [
				{ kind: "human", actorId: "ryan" },
				{ kind: "bot", actorId: researcher.botId },
			],
			nextSeq: 1,
		};
		await this.messagingStore().putChannel(channel);
	},
);

Then("the direct channel open returns identifier {string}", function (this: ChatticusWorld, channelId: string) {
	assert.equal(this.directChannelPayloads.at(-1)!.channel_id, channelId);
});

Then(
	"the direct channel is unnamed with exactly user {string} and bot {string}",
	function (this: ChatticusWorld, userId: string, botName: string) {
		const payload = this.directChannelPayloads.at(-1)!;
		const bot = this.botsByName?.get(botName);
		assert.ok(bot, `Bot ${botName} not found`);
		assert.equal(payload.kind, "direct");
		assert.equal(payload.name, null);
		assert.deepEqual(payload.participants, [
			{ kind: "human", actor_id: userId },
			{ kind: "bot", actor_id: bot.botId },
		]);
	},
);

Then(
	"tenant {string} user {string} lists one direct channel",
	async function (this: ChatticusWorld, tenantId: string, userId: string) {
		const response = await recordResponse(await memberGet(this, orgPath(tenantId, `/users/${userId}/channels`)));
		assert.equal(response.status, 200, response.text);
		const channels = response.json.channels;
		assert.equal(channels.length, 1);
		assert.equal(channels[0].kind, "direct");
	},
);

Then(
	"tenant {string} user {string} lists these channel identities:",
	async function (this: ChatticusWorld, tenantId: string, userId: string, table: DataTable) {
		const response = await recordResponse(await memberGet(this, orgPath(tenantId, `/users/${userId}/channels`)));
		assert.equal(response.status, 200, response.text);
		const names = new Map([...(this.botsByName?.values() ?? [])].map((bot) => [bot.botId, bot.name]));
		const actual = response.json.channels.map((channel: Record<string, any>) => ({
			kind: channel.kind,
			name: channel.name ?? "",
			bots: channel.participants
				.filter((participant: { kind: string }) => participant.kind === "bot")
				.map((participant: { actor_id: string }) => names.get(participant.actor_id))
				.sort()
				.join(", "),
		}));
		const order = (row: { kind: string; name: string }) => `${row.kind}\u0000${row.name}`;
		const expected = table.hashes();
		assert.deepEqual(
			actual.sort((left: any, right: any) => order(left).localeCompare(order(right))),
			expected.sort((left, right) => order(left as any).localeCompare(order(right as any))),
		);
	},
);

When(
	"the front door receives POST \\/orgs\\/{word}\\/channels for user {string} with bots:",
	async function (this: ChatticusWorld, tenantId: string, userId: string, table: DataTable) {
		const botNames = namesFromTable(table);
		const response = await memberPost(this, orgPath(tenantId, "/channels"), {
			user_id: userId,
			kind: botNames.length === 1 ? "direct" : "named",
			name: botNames.length === 1 ? null : "Scenario channel",
			bot_ids: botIdsFor(this, botNames),
		});
		this.lastHttpResponse = response;
		if (response.status === 200) {
			const data = await response.clone().json();
			this.lastChannel = { channelId: data.channel_id, tenantId };
		}
	},
);

Then("the channel response has tenant_id {string}", async function (this: ChatticusWorld, tenantId: string) {
	assert.ok(this.lastHttpResponse, "No last HTTP response");
	assert.equal(this.lastHttpResponse.status, 200);
	assert.equal((await this.lastHttpResponse.json()).tenant_id, tenantId);
});

Given(
	"tenant {string} user {string} has opened a channel with bots:",
	async function (this: ChatticusWorld, tenantId: string, userId: string, table: DataTable) {
		const botNames = namesFromTable(table);
		const payload = await openChannel(
			this,
			tenantId,
			userId,
			botNames.length === 1 ? "direct" : "named",
			botNames,
			botNames.length === 1 ? null : "Scenario channel",
		);
		this.lastChannel = { channelId: payload.channel_id, tenantId };
	},
);

When(
	"tenant {string} posts {string} on the channel via org path {string}",
	async function (this: ChatticusWorld, _tenantId: string, body: string, orgTenant: string) {
		assert.ok(this.lastChannel, "No channel has been opened");
		const response = await memberPost(this, orgPath(orgTenant, `/channels/${this.lastChannel.channelId}/messages`), {
			author_kind: "human",
			author_id: "intruder",
			body,
		});
		this.messageError = response.status === 403 ? new Error((await response.json()).detail) : null;
		if (response.status !== 403) {
			this.messageError = response;
		}
	},
);

Then("posting fails because the tenant does not match", function (this: ChatticusWorld) {
	assert.ok(this.messageError instanceof Error, "Expected the post to be refused with 403");
	assert.match(this.messageError.message, /does not own channel/);
});

Then("the channel has {int} messages", async function (this: ChatticusWorld, count: number) {
	assert.ok(this.lastChannel, "No channel");
	const response = await recordResponse(
		await memberGet(this, orgPath(this.lastChannel.tenantId, `/channels/${this.lastChannel.channelId}/messages`)),
	);
	assert.equal(response.status, 200, response.text);
	assert.equal(response.json.messages.length, count);
});
