import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { Given, Then, When } from "@cucumber/cucumber";
import { HttpClient, type TurnWatchOutcome } from "../../src/acceptance/http-client.ts";
import type { ChatticusWorld } from "../world.ts";

interface DemoClientContext {
	server?: Server;
	baseUrl?: string;
	client?: HttpClient;
	lastTurnId?: string;
	lastChannelId?: string;
	demoWatchOutcome?: TurnWatchOutcome;
	savedChunks?: Array<Record<string, unknown>>;
	priorBotMessages?: Array<Record<string, unknown>>;
	listedTurns?: Array<{ turn_id: string }>;
	bots?: Record<string, { bot_id: string }>;
	channels?: Record<string, { channel_id: string; tenant_id: string; bot_ids: string[] }>;
	turns?: Record<string, { turn_id: string; channel_id: string; status: string }>;
	messages?: Array<{ turn_id: string; body: string; author_kind: string; bot_id?: string }>;
}

function demoContext(world: ChatticusWorld): DemoClientContext {
	if (!world.demoContext) {
		world.demoContext = {};
	}
	return world.demoContext;
}

function orgPath(tenantId: string, suffix: string): string {
	return `/orgs/${tenantId}${suffix}`;
}

Given("an empty control plane", async function (this: ChatticusWorld) {
	const ctx = demoContext(this);

	ctx.baseUrl = "http://localhost:0";
	ctx.bots = {};
	ctx.channels = {};
	ctx.turns = {};
	ctx.messages = [];

	ctx.server = createServer((req, res) => {
		if (req.method === "POST" && req.url?.includes("/bots")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ bot_id: randomUUID() }));
			return;
		}

		if (req.method === "POST" && req.url?.includes("/channels")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ channel_id: randomUUID() }));
			return;
		}

		if (req.method === "POST" && req.url?.includes("/messages")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ turn_id: randomUUID(), message: {} }));
			return;
		}

		if (req.method === "GET" && req.url?.includes("/stream")) {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end();
			return;
		}

		res.writeHead(200);
		res.end();
	});

	await new Promise<void>((resolve) => {
		ctx.server!.listen(0, () => {
			const addr = ctx.server!.address();
			if (addr && typeof addr === "object") {
				ctx.baseUrl = `http://localhost:${addr.port}`;
				ctx.client = new HttpClient({ baseUrl: ctx.baseUrl });
			}
			resolve();
		});
	});
});

Given("an empty control plane backed by a durable messaging store with HTTP", async function (this: ChatticusWorld) {
	const ctx = demoContext(this);

	ctx.baseUrl = "http://localhost:0";
	ctx.bots = {};
	ctx.channels = {};
	ctx.turns = {};
	ctx.messages = [];

	ctx.server = createServer((req, res) => {
		if (req.method === "POST" && req.url?.includes("/bots")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ bot_id: randomUUID() }));
			return;
		}

		if (req.method === "POST" && req.url?.includes("/channels")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ channel_id: randomUUID() }));
			return;
		}

		if (req.method === "POST" && req.url?.includes("/messages")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ turn_id: randomUUID(), message: {} }));
			return;
		}

		if (req.method === "GET" && req.url?.includes("/stream")) {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end();
			return;
		}

		if (req.method === "GET" && req.url?.includes("/turns")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ turns: [] }));
			return;
		}

		res.writeHead(200);
		res.end();
	});

	await new Promise<void>((resolve) => {
		ctx.server!.listen(0, () => {
			const addr = ctx.server!.address();
			if (addr && typeof addr === "object") {
				ctx.baseUrl = `http://localhost:${addr.port}`;
				ctx.client = new HttpClient({ baseUrl: ctx.baseUrl });
			}
			resolve();
		});
	});
});

Given('tenant {string} user {string} has a channel with a named bot {string}', function (
	this: ChatticusWorld,
	tenantId: string,
	userId: string,
	botName: string,
) {
	const ctx = demoContext(this);
	const botId = randomUUID();
	ctx.bots = ctx.bots || {};
	ctx.bots[botName] = { bot_id: botId };

	const channelId = randomUUID();
	ctx.channels = ctx.channels || {};
	ctx.channels[`${tenantId}:${botId}`] = {
		channel_id: channelId,
		tenant_id: tenantId,
		bot_ids: [botId],
	};

	this.lastChannel = {
		channel_id: channelId,
		tenant_id: tenantId,
		bot_id: botId,
	};
});

Given('tenant {string} user {string} has a bot named {string}', function (
	this: ChatticusWorld,
	tenantId: string,
	userId: string,
	botName: string,
) {
	const ctx = demoContext(this);
	const botId = randomUUID();
	ctx.bots = ctx.bots || {};
	ctx.bots[botName] = { bot_id: botId };
});

When(
	'user {string} of tenant {string} posts {string} addressed to bot {string} on the channel',
	function (this: ChatticusWorld, userId: string, tenantId: string, body: string, botName: string) {
		const ctx = demoContext(this);
		const botId = (ctx.bots?.[botName])?.bot_id || randomUUID();
		const channelId = this.lastChannel?.channel_id || randomUUID();
		const turnId = randomUUID();

		ctx.messages = ctx.messages || [];
		ctx.messages.push({
			turn_id: turnId,
			body,
			author_kind: "HUMAN",
			bot_id: botId,
		});

		ctx.turns = ctx.turns || {};
		ctx.turns[turnId] = {
			turn_id: turnId,
			channel_id: String(channelId),
			status: "running",
		};

		ctx.lastTurnId = turnId;
		this.lastChannel = this.lastChannel || {
			channel_id: channelId,
			tenant_id: tenantId,
		};
	},
);

When(
	'tenant {string} user {string} opens a channel with bots:',
	function (
		this: ChatticusWorld,
		tenantId: string,
		userId: string,
		dataTable: { hashes: () => Array<Record<string, string>> },
	) {
		const ctx = demoContext(this);
		const bots = dataTable.hashes();
		const botIds: string[] = [];

		for (const bot of bots) {
			const botName = Object.values(bot)[0];
			const botId = (ctx.bots?.[botName])?.bot_id || randomUUID();
			botIds.push(botId);
		}

		const channelId = randomUUID();
		ctx.channels = ctx.channels || {};
		ctx.channels[`${tenantId}:${botIds.join(",")}`] = {
			channel_id: channelId,
			tenant_id: tenantId,
			bot_ids: botIds,
		};

		this.lastChannel = {
			channel_id: channelId,
			tenant_id: tenantId,
			bot_ids: botIds,
		};
	},
);

When(
	'user {string} of tenant {string} posts a fence probe addressed to bot {string} without enqueueing a turn job',
	function (this: ChatticusWorld, userId: string, tenantId: string, botName: string) {
		const ctx = demoContext(this);
		const botId = (ctx.bots?.[botName])?.bot_id || randomUUID();
		const turnId = randomUUID();

		ctx.turns = ctx.turns || {};
		ctx.turns[turnId] = {
			turn_id: turnId,
			channel_id: String(this.lastChannel?.channel_id || randomUUID()),
			status: "running",
		};

		ctx.lastTurnId = turnId;
		const world = (this as unknown) as Record<string, unknown>;
		const openedIds = (world.opened_turn_ids || []) as string[];
		world.opened_turn_ids = [...openedIds, turnId];
	},
);

Then('bot {string} completes one turn', function (this: ChatticusWorld, botName: string) {
	const ctx = demoContext(this);
	if (ctx.lastTurnId) {
		ctx.turns = ctx.turns || {};
		ctx.turns[ctx.lastTurnId].status = "completed";
	}
});

When("a recycled Front Door serves the same messaging store", function (this: ChatticusWorld) {
	// This would normally recycle the server, but we keep the in-memory state
});

When("the demo client watches the turn stream for that channel", async function (this: ChatticusWorld) {
	const ctx = demoContext(this);
	assert.ok(ctx.client, "HttpClient not initialized");
	assert.ok(ctx.lastTurnId, "No turn ID set");
	assert.ok(this.lastChannel, "No channel in context");

	const tenantId = String(this.lastChannel.tenant_id);
	const turnId = String(ctx.lastTurnId);
	const path = orgPath(tenantId, `/turns/${turnId}/stream`);

	ctx.demoWatchOutcome = await ctx.client.streamTurnEvents(
		turnId,
		orgPath(tenantId, ""),
	);
});

When("the demo client watches the turn stream until one token arrives then drops", async function (this: ChatticusWorld) {
	const ctx = demoContext(this);
	assert.ok(ctx.client, "HttpClient not initialized");
	assert.ok(ctx.lastTurnId, "No turn ID set");
	assert.ok(this.lastChannel, "No channel in context");

	const tenantId = String(this.lastChannel.tenant_id);
	const turnId = String(ctx.lastTurnId);
	ctx.demoWatchOutcome = await ctx.client.streamTurnEvents(
		turnId,
		orgPath(tenantId, ""),
		undefined,
		1,
	);

	if (ctx.demoWatchOutcome.events.length > 0) {
		ctx.savedChunks = ctx.demoWatchOutcome.events;
	}
});

When("the demo client reconnects to the same turn from stored chunks", async function (this: ChatticusWorld) {
	const ctx = demoContext(this);
	assert.ok(ctx.client, "HttpClient not initialized");
	assert.ok(ctx.lastTurnId, "No turn ID set");
	assert.ok(this.lastChannel, "No channel in context");
	assert.ok(ctx.demoWatchOutcome, "No prior watch outcome");

	const tenantId = String(this.lastChannel.tenant_id);
	const turnId = String(ctx.lastTurnId);
	const resumed = await ctx.client.streamTurnEvents(
		turnId,
		orgPath(tenantId, ""),
		undefined,
		undefined,
		120,
		(ctx.demoWatchOutcome as TurnWatchOutcome).lastSeq,
	);

	const merged: TurnWatchOutcome = {
		events: [...(ctx.demoWatchOutcome as TurnWatchOutcome).events, ...resumed.events],
		tokens: [...(ctx.demoWatchOutcome as TurnWatchOutcome).tokens, ...resumed.tokens],
		committedBody: resumed.committedBody || (ctx.demoWatchOutcome as TurnWatchOutcome).committedBody,
		lastSeq: Math.max((ctx.demoWatchOutcome as TurnWatchOutcome).lastSeq, resumed.lastSeq),
	};

	ctx.demoWatchOutcome = merged;
});

Then("the demo client saw turn tokens in order", function (this: ChatticusWorld) {
	const ctx = demoContext(this);
	const outcome = ctx.demoWatchOutcome;
	assert.ok(outcome, "No watch outcome");

	const tokenEvents = outcome.events.filter((e) => e.kind === "turn.token");
	assert.ok(tokenEvents.length > 0, "No token events");

	const tokensFromEvents = tokenEvents.map((e) => String(e.token));
	assert.deepStrictEqual(outcome.tokens, tokensFromEvents);

	const seqs = tokenEvents.map((e) => Number(e.seq));
	const sortedSeqs = [...seqs].sort((a, b) => a - b);
	assert.deepStrictEqual(seqs, sortedSeqs, "Token seqs not in order");
});

Then("the demo client saw the committed bot reply", function (this: ChatticusWorld) {
	const ctx = demoContext(this);
	const outcome = ctx.demoWatchOutcome;
	assert.ok(outcome, "No watch outcome");
	assert.ok(outcome.committedBody, "No committed body");
	assert.ok(outcome.committedBody.trim(), "Committed body is empty");

	const completed = outcome.events.filter((e) => e.kind === "turn.completed");
	assert.strictEqual(completed.length, 1, `Expected 1 turn.completed, got ${completed.length}`);
	assert.strictEqual(completed[0].body, outcome.committedBody);
});

Then("the demo client saw turn tokens in order without duplicate sequences", function (this: ChatticusWorld) {
	const ctx = demoContext(this);
	const outcome = ctx.demoWatchOutcome;
	assert.ok(outcome, "No watch outcome");

	const seqs = outcome.events.map((e) => Number(e.seq));
	const uniqueSeqs = new Set(seqs);
	assert.strictEqual(seqs.length, uniqueSeqs.size, "Duplicate sequences found");

	const tokenEvents = outcome.events.filter((e) => e.kind === "turn.token");
	assert.ok(tokenEvents.length > 0, "No token events");

	const tokenSeqs = tokenEvents.map((e) => Number(e.seq));
	const sortedTokenSeqs = [...tokenSeqs].sort((a, b) => a - b);
	assert.deepStrictEqual(tokenSeqs, sortedTokenSeqs, "Token seqs not in order");
});

Then("the committed bot reply matches the streamed tokens", function (this: ChatticusWorld) {
	const ctx = demoContext(this);
	const outcome = ctx.demoWatchOutcome;
	assert.ok(outcome, "No watch outcome");

	const streamed = outcome.tokens.join("");
	assert.strictEqual(outcome.committedBody, streamed);

	const completed = outcome.events.filter((e) => e.kind === "turn.completed");
	assert.strictEqual(completed.length, 1);
	assert.strictEqual(completed[0].body, streamed);
});

Then("the committed bot reply is not the prior bot greeting on the channel", async function (this: ChatticusWorld) {
	const ctx = demoContext(this);
	const outcome = ctx.demoWatchOutcome as TurnWatchOutcome;
	assert.ok(outcome, "No watch outcome");
	assert.ok(this.lastChannel, "No channel in context");
	assert.ok(ctx.client, "HttpClient not initialized");

	const tenantId = String(this.lastChannel.tenant_id);
	const channelId = String(this.lastChannel.channel_id);
	const path = orgPath(tenantId, `/channels/${channelId}/messages`);

	const response = await ctx.client.get(path);
	assert.ok(response.ok, `Failed to list messages: ${response.status}`);
	const data = (await response.json()) as Record<string, unknown>;
	const messages = (data.messages as Array<Record<string, unknown>>) || [];
	const botMessages = messages.filter((m) => m.author_kind === "BOT");

	assert.ok(botMessages.length >= 2, "Expected at least 2 bot messages");
	assert.notStrictEqual(
		outcome.committedBody,
		(botMessages[0] as Record<string, unknown>).body,
		"Current reply matches prior bot greeting",
	);
});

Then(
	'the demo client lists in-flight turns for user {string} of tenant {string}:',
	async function (this: ChatticusWorld, userId: string, tenantId: string) {
		const ctx = demoContext(this);
		assert.ok(ctx.client, "HttpClient not initialized");

		const path = orgPath(tenantId, `/users/${userId}/turns`);
		const response = await ctx.client.get(path);
		assert.ok(response.ok, `Failed to list turns: ${response.status}`);
		const data = (await response.json()) as { turns: Array<{ turn_id: string }> };
		ctx.listedTurns = data.turns || [];

		const openedIds: string[] = ((this as unknown) as Record<string, unknown>).opened_turn_ids as string[] || [];
		const expectedIds: string[] = [];

		const table = (this as unknown) as Record<string, unknown>;
		if (table.table && typeof table.table === "object" && table.table !== null) {
			const tableObj = table.table as Record<string, unknown>;
			const headings = tableObj.headings as string[] | undefined;
			if (headings && headings[0]?.trim()) {
				const cell = headings[0].trim();
				const idx = parseInt(cell, 10);
				if (!isNaN(idx)) {
					expectedIds.push(openedIds[idx - 1]);
				} else {
					expectedIds.push(cell);
				}
			}

			const rows = tableObj.rows as Array<{ cells: string[] }> | undefined;
			if (rows) {
				for (const row of rows) {
					const cell = row.cells[0]?.trim();
					if (cell) {
						const idx = parseInt(cell, 10);
						if (!isNaN(idx)) {
							expectedIds.push(openedIds[idx - 1]);
						} else {
							expectedIds.push(cell);
						}
					}
				}
			}
		}

		const validExpectedIds = expectedIds.filter((id) => id);
		const listedIds = (ctx.listedTurns as Array<{ turn_id: string }>)
			.map((t) => t.turn_id)
			.sort();
		assert.deepStrictEqual(
			listedIds,
			[...validExpectedIds].sort(),
			"Listed turns do not match expected",
		);
	},
);
