import assert from "node:assert/strict";
import { Given, Then, When, type DataTable } from "@cucumber/cucumber";
import { createBot } from "../../src/domain/bots.ts";
import { createChannel, type Channel } from "../../src/domain/channels.ts";
import type { Organization } from "../../src/domain/organizations.ts";
import { recordResponse, type RecordedResponse } from "../api.ts";
import { list as listMailbox } from "../../src/pi/mailbox.ts";
import { postMessage } from "../../src/domain/messages.ts";
import { bearerFor, executorMessageDependencies } from "../front-door.ts";
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
		const channel = sharedChannelNamed(this, channelName);
		await postMessage(await executorMessageDependencies(this), {
			tenantId: channel.tenantId,
			channelId: channel.channelId,
			authorKind: "bot",
			authorId: botNamed(this, author).botId,
			body,
			addressedToBotId: botNamed(this, addressee).botId,
			idempotencyKey: null,
			enqueueTurn: false,
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
		assert.equal(result.output, content);
	},
);

async function asMemberOnFirstBot<T>(world: ChatticusWorld, email: string, work: (botName: string) => Promise<T>): Promise<T> {
	const botName = [...(world.botsByName?.keys() ?? [])][0]!;
	const creator = world.botCreatorUserIds.get(botName);
	world.botCreatorUserIds.set(botName, userIdOf(world, email));
	try {
		return await work(botName);
	} finally {
		if (creator !== undefined) world.botCreatorUserIds.set(botName, creator);
	}
}

Then(
	"{string} can read {string} as {string} from the organization computer",
	async function (this: ChatticusWorld, email: string, file: string, content: string) {
		const result = await asMemberOnFirstBot(this, email, (botName) =>
			useComputer(this, botName, `read workspace file /workspace/${file}`),
		);
		assert.equal(result.output, content);
	},
);

When(
	"{string} writes {string} containing {string} on the organization computer",
	async function (this: ChatticusWorld, email: string, file: string, content: string) {
		await asMemberOnFirstBot(this, email, (botName) =>
			useComputer(this, botName, `write workspace file /workspace/${file} containing ${content}`),
		);
	},
);

const lastResponses = new WeakMap<ChatticusWorld, RecordedResponse>();

function lastResponseOf(world: ChatticusWorld): RecordedResponse {
	const response = lastResponses.get(world);
	assert.ok(response, "The scenario has not made a request yet.");
	return response;
}

async function openChannelAs(
	world: ChatticusWorld,
	email: string,
	kind: "direct" | "named",
	channelName: string,
	botName: string | null,
): Promise<RecordedResponse> {
	assert.ok(world.api, "The scenario has no HTTP front door.");
	const organization = onlyOrganization(world);
	const response = await recordResponse(
		await world.api.post(`/orgs/${organization.tenantId}/channels`, {
			headers: await bearerFor(world, email),
			body: {
				user_id: userIdOf(world, email),
				kind,
				name: kind === "named" ? channelName : null,
				bot_ids: botName === null ? [] : [botNamed(world, botName).botId],
			},
		}),
	);
	lastResponses.set(world, response);
	if (response.status === 200) {
		world.sharedChannelsByName.set(channelName, { channelId: response.json.channel_id, tenantId: response.json.tenant_id, name: channelName });
	}
	return response;
}

async function addPersonAs(world: ChatticusWorld, email: string, personUserId: string, channelName: string): Promise<void> {
	assert.ok(world.api, "The scenario has no HTTP front door.");
	const channel = sharedChannelNamed(world, channelName);
	lastResponses.set(
		world,
		await recordResponse(
			await world.api.post(`/orgs/${channel.tenantId}/channels/${channel.channelId}/participants`, {
				headers: await bearerFor(world, email),
				body: { user_id: personUserId },
			}),
		),
	);
}

async function removePersonAs(world: ChatticusWorld, email: string, personUserId: string, channelName: string): Promise<void> {
	assert.ok(world.api, "The scenario has no HTTP front door.");
	const channel = sharedChannelNamed(world, channelName);
	lastResponses.set(
		world,
		await recordResponse(
			await world.api.delete(`/orgs/${channel.tenantId}/channels/${channel.channelId}/participants/${personUserId}`, {
				headers: await bearerFor(world, email),
			}),
		),
	);
}

async function readAs(world: ChatticusWorld, email: string, channelName: string): Promise<RecordedResponse> {
	assert.ok(world.api, "The scenario has no HTTP front door.");
	const channel = sharedChannelNamed(world, channelName);
	return recordResponse(
		await world.api.get(`/orgs/${channel.tenantId}/channels/${channel.channelId}/messages`, { headers: await bearerFor(world, email) }),
	);
}

Given(
	"{string} opens named channel {string} with organization bot {string}",
	async function (this: ChatticusWorld, email: string, channelName: string, botName: string) {
		assert.equal((await openChannelAs(this, email, "named", channelName, botName)).status, 200);
	},
);

When(
	"{string} opens direct channel {string} with organization bot {string}",
	async function (this: ChatticusWorld, email: string, channelName: string, botName: string) {
		assert.equal((await openChannelAs(this, email, "direct", channelName, botName)).status, 200);
	},
);

When(
	"{string} opens named channel {string} with no bot",
	async function (this: ChatticusWorld, email: string, channelName: string) {
		assert.equal((await openChannelAs(this, email, "named", channelName, null)).status, 200);
	},
);

When(
	"{string} tries to open a direct channel {string} with no bot",
	async function (this: ChatticusWorld, email: string, channelName: string) {
		await openChannelAs(this, email, "direct", channelName, null);
	},
);

When("{string} tries to open a named channel with no name", async function (this: ChatticusWorld, email: string) {
	await openChannelAs(this, email, "named", "   ", null);
});

When(
	"{string} adds {string} to shared channel {string}",
	async function (this: ChatticusWorld, email: string, person: string, channelName: string) {
		await addPersonAs(this, email, userIdOf(this, person), channelName);
		assert.equal(lastResponseOf(this).status, 200, lastResponseOf(this).text);
	},
);

When(
	"{string} tries to add {string} to shared channel {string}",
	async function (this: ChatticusWorld, email: string, person: string, channelName: string) {
		await addPersonAs(this, email, userIdOf(this, person), channelName);
	},
);

When(
	"{string} tries to add someone outside the organization to shared channel {string}",
	async function (this: ChatticusWorld, email: string, channelName: string) {
		await addPersonAs(this, email, "user-outside-the-organization", channelName);
	},
);

When(
	"{string} removes {string} from shared channel {string}",
	async function (this: ChatticusWorld, email: string, person: string, channelName: string) {
		await removePersonAs(this, email, userIdOf(this, person), channelName);
		assert.equal(lastResponseOf(this).status, 200, lastResponseOf(this).text);
	},
);

When(
	"{string} tries to remove {string} from shared channel {string}",
	async function (this: ChatticusWorld, email: string, person: string, channelName: string) {
		await removePersonAs(this, email, userIdOf(this, person), channelName);
	},
);

When(
	"{string} posts {string} naming no bot in shared channel {string}",
	async function (this: ChatticusWorld, email: string, body: string, channelName: string) {
		assert.ok(this.api, "The scenario has no HTTP front door.");
		const channel = sharedChannelNamed(this, channelName);
		const response = await recordResponse(
			await this.api.post(`/orgs/${channel.tenantId}/channels/${channel.channelId}/messages`, {
				headers: await bearerFor(this, email),
				body: { author_kind: "human", author_id: userIdOf(this, email), body },
			}),
		);
		lastResponses.set(this, response);
		assert.equal(response.status, 200, response.text);
	},
);

When(
	"{string} tries to post {string} in shared channel {string}",
	async function (this: ChatticusWorld, email: string, body: string, channelName: string) {
		assert.ok(this.api, "The scenario has no HTTP front door.");
		const channel = sharedChannelNamed(this, channelName);
		lastResponses.set(
			this,
			await recordResponse(
				await this.api.post(`/orgs/${channel.tenantId}/channels/${channel.channelId}/messages`, {
					headers: await bearerFor(this, email),
					body: { author_kind: "human", author_id: userIdOf(this, email), body },
				}),
			),
		);
	},
);

Then("the request is refused with status {int}", function (this: ChatticusWorld, status: number) {
	assert.equal(lastResponseOf(this).status, status, lastResponseOf(this).text);
});

Then("the shared channel post started no turn", function (this: ChatticusWorld) {
	assert.equal(lastResponseOf(this).json.turn_id, null);
});

Then(
	"organization bot {string} has a message from {string} saying {string} waiting in shared channel {string}",
	async function (this: ChatticusWorld, botName: string, email: string, body: string, channelName: string) {
		const channel = sharedChannelNamed(this, channelName);
		const bot = botNamed(this, botName);
		const dependencies = await executorMessageDependencies(this);
		const waiting = await listMailbox(dependencies.mailbox, channel.tenantId, bot.botId, channel.channelId);
		assert.deepEqual(
			waiting.map((item) => ({ authorId: item.authorId, body: item.body, addressedToBotId: item.addressedToBotId })),
			[{ authorId: userIdOf(this, email), body, addressedToBotId: null }],
		);
	},
);

Then(
	"{string} cannot read shared channel {string}",
	async function (this: ChatticusWorld, email: string, channelName: string) {
		assert.equal((await readAs(this, email, channelName)).status, 403);
	},
);

Then(
	"{string} lists shared channel {string} among their channels",
	async function (this: ChatticusWorld, email: string, channelName: string) {
		assert.ok(this.api, "The scenario has no HTTP front door.");
		const channel = sharedChannelNamed(this, channelName);
		const response = await recordResponse(
			await this.api.get(`/orgs/${channel.tenantId}/users/${userIdOf(this, email)}/channels`, { headers: await bearerFor(this, email) }),
		);
		assert.equal(response.status, 200, response.text);
		assert.ok((response.json.channels as Array<{ channel_id: string }>).some((listed) => listed.channel_id === channel.channelId));
	},
);

Then(
	"{string} does not list shared channel {string} among their channels",
	async function (this: ChatticusWorld, email: string, channelName: string) {
		assert.ok(this.api, "The scenario has no HTTP front door.");
		const channel = sharedChannelNamed(this, channelName);
		const response = await recordResponse(
			await this.api.get(`/orgs/${channel.tenantId}/users/${userIdOf(this, email)}/channels`, { headers: await bearerFor(this, email) }),
		);
		assert.equal(response.status, 200, response.text);
		assert.ok(!(response.json.channels as Array<{ channel_id: string }>).some((listed) => listed.channel_id === channel.channelId));
	},
);
