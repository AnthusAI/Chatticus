import assert from "node:assert/strict";
import { Given, Then, When, type DataTable } from "@cucumber/cucumber";
import { createBot } from "../../src/domain/bots.ts";
import type { TurnRunJob } from "../../src/domain/turn-admission.ts";
import { DynamoTurnAdmission } from "../../src/store/turn-admission-store.ts";
import { recordResponse, type RecordedResponse } from "../api.ts";
import { TURN_RUN_QUEUE } from "../front-door.ts";
import { memberGet, memberPost } from "../org-user-client.ts";
import type { ChatticusWorld } from "../world.ts";

function openChannelOf(world: ChatticusWorld): { channelId: string; tenantId: string } {
	assert.ok(world.lastChannel, "No channel has been opened");
	return world.lastChannel;
}

function botNamed(world: ChatticusWorld, name: string): { botId: string; name: string; tenantId: string } {
	const bot = world.botsByName?.get(name);
	assert.ok(bot, `Bot ${name} not found`);
	return bot;
}

function messagesPath(tenantId: string, channelId: string): string {
	return `/orgs/${tenantId}/channels/${channelId}/messages`;
}

export type PostRequest = {
	authorKind: "human" | "bot";
	authorId: string;
	body: string;
	addressedToBotId: string | null;
	tenantId?: string;
	idempotencyKey?: string;
	enqueueTurn?: boolean;
};

export async function post(world: ChatticusWorld, request: PostRequest): Promise<RecordedResponse> {
	const channel = openChannelOf(world);
	const payload: Record<string, unknown> = {
		author_kind: request.authorKind,
		author_id: request.authorId,
		body: request.body,
		addressed_to_bot_id: request.addressedToBotId,
	};
	if (request.enqueueTurn === false) {
		payload.enqueue_turn = false;
	}
	const headers: Record<string, string> = request.idempotencyKey === undefined ? {} : { "Idempotency-Key": request.idempotencyKey };
	const response = await recordResponse(
		await memberPost(world, messagesPath(request.tenantId ?? channel.tenantId, channel.channelId), payload, headers),
	);
	world.postResponses.push(response);
	world.lastTurnId = response.status === 200 ? (response.json.turn_id ?? null) : world.lastTurnId;
	return response;
}

async function postAccepted(world: ChatticusWorld, request: PostRequest): Promise<RecordedResponse> {
	const response = await post(world, request);
	assert.equal(response.status, 200, response.text);
	return response;
}

async function listMessages(world: ChatticusWorld, afterSeq?: number): Promise<Array<Record<string, any>>> {
	const channel = openChannelOf(world);
	const suffix = afterSeq === undefined ? "" : `?after=${afterSeq}`;
	const response = await recordResponse(await memberGet(world, `${messagesPath(channel.tenantId, channel.channelId)}${suffix}`));
	assert.equal(response.status, 200, response.text);
	return response.json.messages;
}

async function messageAtSeq(world: ChatticusWorld, seq: number): Promise<Record<string, any>> {
	const found = (await listMessages(world)).find((message) => message.seq === seq);
	assert.ok(found, `The channel has no message with seq ${seq}`);
	return found;
}

function queuedRunJobs(world: ChatticusWorld): TurnRunJob[] {
	return world.queues.pending(TURN_RUN_QUEUE).map((queued) => queued.body as TurnRunJob);
}

function botIdsFor(world: ChatticusWorld, table: DataTable): string[] {
	return table
		.raw()
		.map((row) => (row[0] ?? "").trim())
		.filter((name) => name !== "")
		.map((name) => botNamed(world, name).botId);
}

export async function openChannelForTable(
	world: ChatticusWorld,
	tenantId: string,
	userId: string,
	table: DataTable,
	headers: Record<string, string>,
): Promise<Record<string, any>> {
	const botIds = botIdsFor(world, table);
	const response = await recordResponse(
		await memberPost(
			world,
			`/orgs/${tenantId}/channels`,
			{
				user_id: userId,
				bot_ids: botIds,
				kind: botIds.length === 1 ? "direct" : "named",
				name: botIds.length === 1 ? null : "Scenario channel",
			},
			headers,
		),
	);
	assert.equal(response.status, 200, response.text);
	world.lastChannel = { channelId: response.json.channel_id, tenantId };
	return response.json;
}

/** Create the bot when the scenario has none by that name and open a direct channel between the user and it. */
export async function openChannelWithNamedBot(
	world: ChatticusWorld,
	tenantId: string,
	userId: string,
	botName: string,
): Promise<void> {
	let bot = world.botsByName?.get(botName);
	if (bot === undefined) {
		bot = await createBot(tenantId, botName, { creatorUserId: userId }, { store: world.messagingStore(), ids: world.ids });
		world.botsById?.set(bot.botId, bot);
		world.botsByName?.set(botName, bot);
	}
	const response = await recordResponse(
		await memberPost(world, `/orgs/${tenantId}/channels`, {
			user_id: userId,
			bot_ids: [bot.botId],
			kind: "direct",
			name: null,
		}),
	);
	assert.equal(response.status, 200, response.text);
	world.lastChannel = { channelId: response.json.channel_id, tenantId };
}

Given(
	"tenant {string} user {string} has a channel with a named bot {string}",
	async function (this: ChatticusWorld, tenantId: string, userId: string, botName: string) {
		await openChannelWithNamedBot(this, tenantId, userId, botName);
	},
);

When(
	"tenant {string} user {string} opens a channel with bots:",
	async function (this: ChatticusWorld, tenantId: string, userId: string, table: DataTable) {
		const channel = await openChannelForTable(this, tenantId, userId, table, {});
		this.openedChannelIds.push(channel.channel_id);
	},
);

When(
	"tenant {string} user {string} opens a channel with idempotency key {string} with bots:",
	async function (this: ChatticusWorld, tenantId: string, userId: string, key: string, table: DataTable) {
		const channel = await openChannelForTable(this, tenantId, userId, table, { "Idempotency-Key": key });
		this.idempotentChannelIds.push(channel.channel_id);
	},
);

When(
	"user {string} of tenant {string} posts {string} addressed to bot {string} on the channel",
	async function (this: ChatticusWorld, userId: string, tenantId: string, body: string, botName: string) {
		await post(this, {
			authorKind: "human",
			authorId: userId,
			body,
			addressedToBotId: botNamed(this, botName).botId,
			tenantId,
		});
	},
);

When(
	"user {string} of tenant {string} posts {string} addressed to bot {string} on the channel with idempotency key {string}",
	async function (this: ChatticusWorld, userId: string, tenantId: string, body: string, botName: string, key: string) {
		await postAccepted(this, {
			authorKind: "human",
			authorId: userId,
			body,
			addressedToBotId: botNamed(this, botName).botId,
			tenantId,
			idempotencyKey: key,
		});
	},
);

When(
	"user {string} of tenant {string} posts {string} on the channel without addressing a bot",
	async function (this: ChatticusWorld, userId: string, tenantId: string, body: string) {
		await postAccepted(this, { authorKind: "human", authorId: userId, body, addressedToBotId: null, tenantId });
	},
);

When(
	"user {string} of tenant {string} posts a fence probe addressed to bot {string} without enqueueing a turn job",
	async function (this: ChatticusWorld, userId: string, tenantId: string, botName: string) {
		await postAccepted(this, {
			authorKind: "human",
			authorId: userId,
			body: "Fence probe; do not wait on this turn.",
			addressedToBotId: botNamed(this, botName).botId,
			tenantId,
			enqueueTurn: false,
		});
	},
);

When(
	"bot {string} posts {string} addressed to bot {string} on the channel",
	async function (this: ChatticusWorld, authorName: string, body: string, addresseeName: string) {
		await postAccepted(this, {
			authorKind: "bot",
			authorId: botNamed(this, authorName).botId,
			body,
			addressedToBotId: botNamed(this, addresseeName).botId,
		});
	},
);

When(
	"user {string} of tenant {string} posts {string}, {string} and {string} on the channel at the same time",
	async function (this: ChatticusWorld, userId: string, tenantId: string, first: string, second: string, third: string) {
		const responses = await Promise.all(
			[first, second, third].map((body) => post(this, { authorKind: "human", authorId: userId, body, addressedToBotId: null, tenantId })),
		);
		for (const response of responses) {
			assert.equal(response.status, 200, response.text);
		}
	},
);

When("tenant {string} posts {string} on the channel", async function (this: ChatticusWorld, tenantId: string, body: string) {
	const response = await post(this, { authorKind: "human", authorId: "intruder", body, addressedToBotId: null, tenantId });
	assert.equal(response.status, 403, response.text);
	this.messageError = new Error(response.json.detail);
});

Given("another tenant {string} knows the channel identifier", function (this: ChatticusWorld, tenantId: string) {
	openChannelOf(this);
	this.otherTenantId = tenantId;
});

When("tenant {string} tries to post or read on the channel", async function (this: ChatticusWorld, tenantId: string) {
	const channel = openChannelOf(this);
	const attempts = [
		await memberPost(this, messagesPath(tenantId, channel.channelId), {
			author_kind: "human",
			author_id: "intruder",
			body: "intrusion",
			addressed_to_bot_id: null,
		}),
		await memberGet(this, messagesPath(tenantId, channel.channelId)),
	];
	const denials: string[] = [];
	for (const attempt of attempts) {
		const recorded = await recordResponse(attempt);
		assert.equal(recorded.status, 403, `${attempt.url} answered ${recorded.status}: ${recorded.text}`);
		denials.push(recorded.json.detail);
	}
	this.accessDenial = denials.join("\n");
});

Then("access is denied", function (this: ChatticusWorld) {
	assert.ok(this.accessDenial, "No access attempt was refused");
	assert.equal(this.accessDenial.split("\n").length, 2, "Posting and reading messages must both be refused");
	for (const detail of this.accessDenial.split("\n")) {
		assert.match(detail, /does not own channel/);
	}
});

Then("the channel is unchanged", async function (this: ChatticusWorld) {
	assert.deepEqual(await listMessages(this), []);
});

Then("the message with seq {int} has body {string}", async function (this: ChatticusWorld, seq: number, body: string) {
	assert.equal((await messageAtSeq(this, seq)).body, body);
});

Then("the message with seq {int} is from the human {string}", async function (this: ChatticusWorld, seq: number, userId: string) {
	const message = await messageAtSeq(this, seq);
	assert.equal(message.author_kind, "human");
	assert.equal(message.author_id, userId);
});

Then("the message with seq {int} is from bot {string}", async function (this: ChatticusWorld, seq: number, botName: string) {
	const message = await messageAtSeq(this, seq);
	assert.equal(message.author_kind, "bot");
	assert.equal(message.author_id, botNamed(this, botName).botId);
});

Then("the human can read both messages on the channel", async function (this: ChatticusWorld) {
	assert.equal((await listMessages(this)).length, 2);
});

When(
	"user {string} of tenant {string} lists channel messages after seq {int}",
	async function (this: ChatticusWorld, _userId: string, _tenantId: string, seq: number) {
		this.listedMessages = await listMessages(this, seq);
	},
);

Then("the listing contains only the message with seq {int}", function (this: ChatticusWorld, seq: number) {
	assert.ok(this.listedMessages, "No listing was requested");
	assert.deepEqual(
		this.listedMessages.map((message) => message.seq),
		[seq],
	);
});

Then("the channel messages have sequence numbers {int}, {int} and {int}", async function (this: ChatticusWorld, first: number, second: number, third: number) {
	const messages = await listMessages(this);
	assert.deepEqual(
		messages.map((message) => message.seq),
		[first, second, third],
	);
	assert.deepEqual(
		new Set(messages.map((message) => message.body)),
		new Set(["one", "two", "three"]),
	);
});

Then(
	"bot {string} has {int} pending turn with required capabilities:",
	function (this: ChatticusWorld, botName: string, count: number, table: DataTable) {
		const jobs = queuedRunJobs(this).filter((job) => job.botId === botNamed(this, botName).botId);
		assert.equal(jobs.length, count);
		const expected = table.raw().map((row) => (row[0] ?? "").trim());
		assert.deepEqual([...jobs[0]!.requiredCapabilities].sort(), expected.sort());
	},
);

Then("bot {string} has 0 pending turns", function (this: ChatticusWorld, botName: string) {
	assert.deepEqual(
		queuedRunJobs(this).filter((job) => job.botId === botNamed(this, botName).botId),
		[],
	);
});

Then("the cpu enqueue hook was not invoked", function (this: ChatticusWorld) {
	assert.deepEqual(queuedRunJobs(this), []);
});

Then("the channel has a turn", async function (this: ChatticusWorld) {
	const channel = openChannelOf(this);
	const turnId = this.lastTurnId;
	assert.ok(turnId, "The last post started no turn");
	const addressed = (await listMessages(this)).at(-1)?.addressed_to_bot_id;
	assert.ok(addressed, "The last message addressed no bot");
	const admission = new DynamoTurnAdmission(this.messagingTable.client, this.messagingTable.tableName);
	const open = await admission.openTurn(channel.tenantId, channel.channelId, addressed);
	assert.ok(open, "The bot has no turn on the channel");
	assert.equal(open.pointerTurnId, turnId);
	assert.equal(open.active, true);
	assert.equal(
		queuedRunJobs(this).filter((job) => job.turnId === turnId).length,
		0,
		"A run job was queued for the probe turn",
	);
});

Then("both posts answered with the same turn", function (this: ChatticusWorld) {
	const [first, second] = this.postResponses.slice(-2);
	assert.ok(first && second, "Two posts are required");
	assert.ok(first.json.turn_id, "The first post started no turn");
	assert.equal(second.json.turn_id, first.json.turn_id);
});

Then("all three posts answered with the same turn", function (this: ChatticusWorld) {
	const responses = this.postResponses.slice(-3);
	assert.equal(responses.length, 3, "Three posts are required");
	assert.ok(responses[0]!.json.turn_id, "The first post started no turn");
	for (const response of responses) {
		assert.equal(response.json.turn_id, responses[0]!.json.turn_id);
	}
});

Then("the two posts started different turns", function (this: ChatticusWorld) {
	const [first, second] = this.postResponses.slice(-2);
	assert.ok(first && second, "Two posts are required");
	assert.ok(first.json.turn_id && second.json.turn_id, "Both posts must start a turn");
	assert.notEqual(second.json.turn_id, first.json.turn_id);
});

Then("the post started no turn", function (this: ChatticusWorld) {
	const response = this.postResponses.at(-1);
	assert.ok(response);
	assert.equal(response.json.turn_id, null);
});

Then("the post is refused because the author is not a participant", function (this: ChatticusWorld) {
	const response = this.postResponses.at(-1);
	assert.ok(response, "No post was attempted");
	assert.equal(response.status, 403);
	assert.match(response.json.detail, /^human 'stranger' is not a participant of channel /);
});

Then("the post is refused because the addressee is not a participant", function (this: ChatticusWorld) {
	const response = this.postResponses.at(-1);
	assert.ok(response, "No post was attempted");
	assert.equal(response.status, 403);
	assert.match(response.json.detail, new RegExp(`^bot '${botNamed(this, "Outsider").botId}' is not a participant of channel `));
});

Then("the opened channel identifier is unchanged", function (this: ChatticusWorld) {
	assert.equal(this.idempotentChannelIds.length, 2);
	assert.equal(this.idempotentChannelIds[1], this.idempotentChannelIds[0]);
});

Then("tenant {string} can read the open channel by identifier", async function (this: ChatticusWorld, tenantId: string) {
	const channel = openChannelOf(this);
	const response = await recordResponse(await memberGet(this, `/orgs/${tenantId}/channels/${channel.channelId}`));
	assert.equal(response.status, 200, response.text);
	assert.equal(response.json.channel_id, channel.channelId);
	assert.equal(response.json.tenant_id, tenantId);
	const participantIds = response.json.participants.map((participant: { actor_id: string }) => participant.actor_id);
	assert.ok(participantIds.includes(response.json.user_id));
	assert.equal(participantIds.length, 1 + [...(this.botsByName?.values() ?? [])].filter((bot) => participantIds.includes(bot.botId)).length);
});

Then(
	"tenant {string} can list channels for user {string}:",
	async function (this: ChatticusWorld, tenantId: string, userId: string, table: DataTable) {
		const expected = table
			.raw()
			.map((row) => (row[0] ?? "").trim())
			.filter((cell) => cell !== "")
			.map((cell) => this.openedChannelIds[Number(cell) - 1]!);
		const response = await recordResponse(await memberGet(this, `/orgs/${tenantId}/users/${userId}/channels`));
		assert.equal(response.status, 200, response.text);
		assert.deepEqual(
			response.json.channels.map((channel: { channel_id: string }) => channel.channel_id),
			[...expected].sort(),
		);
		for (const channel of response.json.channels) {
			assert.equal(channel.tenant_id, tenantId);
			assert.equal(channel.user_id, userId);
		}
	},
);
