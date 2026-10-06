import assert from "node:assert/strict";
import { Given, Then, When, type DataTable } from "@cucumber/cucumber";
import { createBot } from "../../src/domain/bots.ts";
import { createChannel, type Channel } from "../../src/domain/channels.ts";
import type { Organization } from "../../src/domain/organizations.ts";
import { recordResponse } from "../api.ts";
import { bearerFor } from "../front-door.ts";
import { useComputer } from "./shared-computer.steps.ts";
import type { ChatticusWorld } from "../world.ts";

function organizationNamed(world: ChatticusWorld, name: string): Organization {
	const organization = world.orgsByName?.get(name);
	assert.ok(organization, `Unknown organization ${JSON.stringify(name)}.`);
	return organization;
}

function userIdOf(world: ChatticusWorld, email: string): string {
	const identity = world.identitiesByEmail?.get(email);
	assert.ok(identity, `Unknown member ${JSON.stringify(email)}.`);
	return identity.userId;
}

function memberEmails(world: ChatticusWorld): string[] {
	return [...(world.identitiesByEmail?.keys() ?? [])];
}

function namesOf(table: DataTable): string[] {
	return table
		.raw()
		.map((row) => (row[0] ?? "").trim())
		.filter((name) => name !== "");
}

function botNamed(world: ChatticusWorld, name: string): { botId: string; tenantId: string } {
	const bot = world.botsByName?.get(name);
	assert.ok(bot, `Unknown organization bot ${JSON.stringify(name)}.`);
	return bot;
}

function sharedChannelNamed(world: ChatticusWorld, name: string): { channelId: string; tenantId: string; name: string } {
	const channel = world.sharedChannelsByName.get(name);
	assert.ok(channel, `Unknown shared channel ${JSON.stringify(name)}.`);
	return channel;
}

function onlyOrganization(world: ChatticusWorld): Organization {
	const organizations = [...(world.orgsByName?.values() ?? [])];
	assert.equal(organizations.length, 1, "The scenario has more than one organization.");
	return organizations[0]!;
}

async function openSharedChannel(
	world: ChatticusWorld,
	organizationName: string,
	channelName: string,
	botNames: readonly string[],
): Promise<void> {
	const organization = organizationNamed(world, organizationName);
	const emails = memberEmails(world);
	const channel: Channel = await createChannel(
		organization.tenantId,
		userIdOf(world, emails[0]!),
		botNames.map((name) => botNamed(world, name).botId),
		{ kind: "named", name: channelName },
		{ store: world.messagingStore(), ids: world.ids },
	);
	const humans = emails.slice(1).map((email) => ({ kind: "human" as const, actorId: userIdOf(world, email) }));
	await world.messagingStore().putChannel({ ...channel, participants: [...channel.participants, ...humans] });
	world.sharedChannelsByName.set(channelName, { channelId: channel.channelId, tenantId: channel.tenantId, name: channelName });
}

async function postToSharedChannel(
	world: ChatticusWorld,
	channelName: string,
	asEmail: string,
	body: Record<string, unknown>,
): Promise<void> {
	assert.ok(world.api, "The scenario has no HTTP front door.");
	const channel = sharedChannelNamed(world, channelName);
	const response = await recordResponse(
		await world.api.post(`/orgs/${channel.tenantId}/channels/${channel.channelId}/messages`, {
			headers: await bearerFor(world, asEmail),
			body: { ...body, enqueue_turn: false },
		}),
	);
	assert.equal(response.status, 200, response.text);
}

async function sharedChannelMessagesFor(world: ChatticusWorld, email: string, channelName: string): Promise<Array<Record<string, any>>> {
	assert.ok(world.api, "The scenario has no HTTP front door.");
	const channel = sharedChannelNamed(world, channelName);
	const response = await recordResponse(
		await world.api.get(`/orgs/${channel.tenantId}/channels/${channel.channelId}/messages`, { headers: await bearerFor(world, email) }),
	);
	assert.equal(response.status, 200, response.text);
	return response.json.messages;
}

Given(
	"organization {string} has organization bots:",
	async function (this: ChatticusWorld, organizationName: string, table: DataTable) {
		const organization = organizationNamed(this, organizationName);
		const ownerEmail = memberEmails(this)[0]!;
		const ownerUserId = userIdOf(this, ownerEmail);
		this.testOwnerEmails.set(organization.tenantId, ownerEmail);
		for (const name of namesOf(table)) {
			const bot = await createBot(
				organization.tenantId,
				name,
				{ creatorUserId: ownerUserId },
				{ store: this.messagingStore(), ids: this.ids },
			);
			this.botsById?.set(bot.botId, bot);
			this.botsByName?.set(name, bot);
			this.botCreatorUserIds.set(name, ownerUserId);
		}
	},
);

Given(
	"organization {string} has shared channel {string} with organization bots:",
	async function (this: ChatticusWorld, organizationName: string, channelName: string, table: DataTable) {
		await openSharedChannel(this, organizationName, channelName, namesOf(table));
	},
);

When(
	"{string} posts {string} in shared channel {string}",
	async function (this: ChatticusWorld, email: string, body: string, channelName: string) {
		await postToSharedChannel(this, channelName, email, { author_kind: "human", author_id: userIdOf(this, email), body });
	},
);

When("{string} creates organization bot {string}", async function (this: ChatticusWorld, email: string, name: string) {
	assert.ok(this.api, "The scenario has no HTTP front door.");
	const organization = onlyOrganization(this);
	const response = await recordResponse(
		await this.api.post(`/orgs/${organization.tenantId}/bots`, { headers: await bearerFor(this, email), body: { name } }),
	);
	assert.equal(response.status, 200, response.text);
	const bot = { botId: response.json.bot_id as string, name, tenantId: response.json.tenant_id as string };
	this.botsById?.set(bot.botId, bot);
	this.botsByName?.set(name, bot);
	this.botCreatorUserIds.set(name, userIdOf(this, email));
});

When(
	"organization bot {string} writes {string} containing {string} on the organization computer",
	async function (this: ChatticusWorld, botName: string, file: string, content: string) {
		await useComputer(this, botName, `write workspace file /workspace/${file} containing ${content}`);
	},
);

When(
	"organization bot {string} posts {string} addressed to organization bot {string} in shared channel {string}",
	async function (this: ChatticusWorld, author: string, body: string, addressee: string, channelName: string) {
		await postToSharedChannel(this, channelName, memberEmails(this)[0]!, {
			author_kind: "bot",
			author_id: botNamed(this, author).botId,
			body,
			addressed_to_bot_id: botNamed(this, addressee).botId,
		});
	},
);

Then(
	"{string} can read {int} messages in shared channel {string}",
	async function (this: ChatticusWorld, email: string, count: number, channelName: string) {
		assert.equal((await sharedChannelMessagesFor(this, email, channelName)).length, count);
	},
);

Then(
	"the shared channel message with seq {int} has body {string}",
	async function (this: ChatticusWorld, seq: number, body: string) {
		const [channelName] = [...this.sharedChannelsByName.keys()];
		const messages = await sharedChannelMessagesFor(this, memberEmails(this)[0]!, channelName!);
		assert.equal(messages.find((message) => message.seq === seq)?.body, body);
	},
);

Then("{string} lists organization bot {string}", async function (this: ChatticusWorld, email: string, name: string) {
	assert.ok(this.api, "The scenario has no HTTP front door.");
	const organization = onlyOrganization(this);
	const response = await recordResponse(
		await this.api.get(`/orgs/${organization.tenantId}/users/${userIdOf(this, email)}/bots`, { headers: await bearerFor(this, email) }),
	);
	assert.equal(response.status, 200, response.text);
	assert.ok((response.json.bots as Array<{ name: string }>).some((bot) => bot.name === name), response.text);
});

Then(
	"organization bot {string} belongs to organization {string}",
	function (this: ChatticusWorld, botName: string, organizationName: string) {
		assert.equal(botNamed(this, botName).tenantId, organizationNamed(this, organizationName).tenantId);
	},
);

Then(
	"{string} cannot create a second organization bot named {string}",
	async function (this: ChatticusWorld, email: string, name: string) {
		assert.ok(this.api, "The scenario has no HTTP front door.");
		const organization = onlyOrganization(this);
		const response = await recordResponse(
			await this.api.post(`/orgs/${organization.tenantId}/bots`, { headers: await bearerFor(this, email), body: { name } }),
		);
		assert.equal(response.status, 400, response.text);
	},
);

Then(
	"organization bot {string} can read {string} as {string} from the organization computer",
	async function (this: ChatticusWorld, botName: string, file: string, content: string) {
		const result = await useComputer(this, botName, `read workspace file /workspace/${file}`);
		assert.equal(result.body, content);
	},
);

Then(
	"{string} can continue file {string} on the organization computer",
	async function (this: ChatticusWorld, email: string, file: string) {
		const botName = [...(this.botsByName?.keys() ?? [])][0]!;
		const memberUserId = userIdOf(this, email);
		const creator = this.botCreatorUserIds.get(botName);
		this.botCreatorUserIds.set(botName, memberUserId);
		try {
			const existing = await useComputer(this, botName, `read workspace file /workspace/${file}`);
			const continued = `${existing.body} continued`;
			await useComputer(this, botName, `write workspace file /workspace/${file} containing ${continued}`);
			const reread = await useComputer(this, botName, `read workspace file /workspace/${file}`);
			assert.equal(reread.body, continued);
		} finally {
			if (creator !== undefined) this.botCreatorUserIds.set(botName, creator);
		}
	},
);
