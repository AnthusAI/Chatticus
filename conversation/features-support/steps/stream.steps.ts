import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { appendTurnEvent, failTurn, getTurn } from "../../src/domain/turns.ts";
import { turnItemPartitionKey } from "../../src/store/turn-events.ts";
import { recordResponse } from "../api.ts";
import { modelScenarioOf } from "../executor-harness.ts";
import { memberGet } from "../org-user-client.ts";
import { TurnWatcher } from "../turn-watcher.ts";
import type { ChatticusWorld } from "../world.ts";
import { claimAs, completeAs, currentTurnId, openChannelOf, postToBot } from "./turn.steps.ts";

const WORKER = "sse-worker";
const MAXIMUM_PUMPED_SECONDS = 60;

function watcherOf(world: ChatticusWorld): TurnWatcher {
	const watcher = modelScenarioOf(world).watcher;
	assert.ok(watcher, "No one is watching the turn");
	return watcher;
}

function attemptOf(world: ChatticusWorld): string {
	const attempt = world.turnAttempts.get("current");
	assert.ok(attempt, "No worker has claimed the turn");
	return attempt;
}

async function startClaimedTurn(world: ChatticusWorld, botName: string): Promise<void> {
	await postToBot(world, botName, "hello", true);
	const channel = openChannelOf(world);
	const claim = await claimAs(world, channel.tenantId, currentTurnId(world), WORKER);
	assert.ok(claim, "The worker could not claim the turn");
	world.turnAttempts.set("current", claim.attemptId);
}

async function postChunk(world: ChatticusWorld, token: string): Promise<void> {
	await appendTurnEvent(world.turnDependencies(), openChannelOf(world).tenantId, currentTurnId(world), attemptOf(world), {
		kind: "turn.token",
		token,
	});
}

async function completeTurnWith(world: ChatticusWorld, body: string): Promise<void> {
	await completeAs(world, openChannelOf(world).tenantId, currentTurnId(world), attemptOf(world), body);
}

/**
 * Let time pass for a watcher on a controlled clock until its stream ends: every pause the stream takes between polls is
 * answered with a second of stream time, so an event written after the stream went quiet still reaches it.
 */
async function letStreamTimePassUntilClosed(world: ChatticusWorld, watcher: TurnWatcher): Promise<void> {
	const controlled = world.streamClock.controlledClock;
	if (controlled === null) {
		await watcher.untilClosed();
		return;
	}
	for (let second = 0; second < MAXIMUM_PUMPED_SECONDS && !watcher.closed; second++) {
		await Promise.race([watcher.closedSignal, controlled.untilPolling()]);
		if (watcher.closed) break;
		await controlled.advance(1000);
	}
	await watcher.untilClosed();
}

Given(
	"bot {string} is producing an answer for a turn on the channel",
	async function (this: ChatticusWorld, name: string) {
		await startClaimedTurn(this, name);
	},
);

When("the worker posts several coalesced progress chunks for the turn", async function (this: ChatticusWorld) {
	await postChunk(this, "Hel");
	await postChunk(this, "lo");
});

async function assertChunksInOrderBeforeCompletion(world: ChatticusWorld): Promise<void> {
	const watcher = watcherOf(world);
	await watcher.until(() => watcher.events.filter((event) => event.kind === "turn.token").length >= 2, "both chunks");
	assert.deepEqual(
		watcher.events.filter((event) => event.kind === "turn.token").map((event) => event.payload.token),
		["Hel", "lo"],
	);
	const turn = await getTurn(world.turnDependencies(), openChannelOf(world).tenantId, currentTurnId(world));
	assert.equal(turn.status, "active");
}

async function completeAndAssertOneTerminalEvent(world: ChatticusWorld): Promise<void> {
	await completeTurnWith(world, "Hello");
	const watcher = watcherOf(world);
	await watcher.until(() => watcher.events.some((event) => event.kind === "turn.completed"), "the terminal event");
	assert.equal(watcher.events.filter((event) => event.kind === "turn.completed").length, 1);
}

Then(
	"user {string} receives the chunks in order before completion",
	async function (this: ChatticusWorld, _userId: string) {
		await assertChunksInOrderBeforeCompletion(this);
	},
);

Then("user {string} receives one terminal server-sent event", async function (this: ChatticusWorld, _userId: string) {
	await completeAndAssertOneTerminalEvent(this);
});

When(
	"the web UI opens a turn stream for user {string} of tenant {string}",
	async function (this: ChatticusWorld, _userId: string, tenantId: string) {
		modelScenarioOf(this).watcher = await TurnWatcher.open(this, tenantId, currentTurnId(this));
	},
);

Then("the web UI receives the chunks in order before completion", async function (this: ChatticusWorld) {
	await assertChunksInOrderBeforeCompletion(this);
});

When("the worker completes the turn", async function (this: ChatticusWorld) {
	await completeTurnWith(this, "Hello");
});

Then("the web UI receives a turn completed event", async function (this: ChatticusWorld) {
	const watcher = watcherOf(this);
	await watcher.until(() => watcher.events.some((event) => event.kind === "turn.completed"), "the terminal event");
	assert.equal(watcher.events.filter((event) => event.kind === "turn.completed").length, 1);
});

Then("the web UI turn stream is closed", async function (this: ChatticusWorld) {
	await letStreamTimePassUntilClosed(this, watcherOf(this));
});

Then("the turn stream ends", async function (this: ChatticusWorld) {
	await letStreamTimePassUntilClosed(this, watcherOf(this));
});

Then("no connection remains open for the channel or chat tab", async function (this: ChatticusWorld) {
	await watcherOf(this).untilClosed();
	assert.equal(this.openStreams.open, 0);
});

Given("a turn has emitted committed events through sequence {int}", async function (this: ChatticusWorld, seq: number) {
	await startClaimedTurn(this, "Researcher");
	for (const token of ["Hel", "lo", "!"]) {
		await postChunk(this, token);
	}
	const events = await listEvents(this, 0);
	assert.equal(events[events.length - 1]!.seq, seq, "the committed events do not end at the named sequence");
});

async function listEvents(world: ChatticusWorld, after: number): Promise<Array<Record<string, any>>> {
	const response = await recordResponse(
		await memberGet(world, `/orgs/${openChannelOf(world).tenantId}/turns/${currentTurnId(world)}/events?after=${after}`),
	);
	assert.equal(response.status, 200, response.text);
	return response.json.events;
}

Given("the watching connection for that turn closes", async function (this: ChatticusWorld) {
	const scenario = modelScenarioOf(this);
	if (scenario.watcher !== undefined) {
		await scenario.watcher.disconnect();
		scenario.watcher = undefined;
	}
});

When(
	"user {string} of tenant {string} reconnects to the turn with Last-Event-ID {int}",
	async function (this: ChatticusWorld, _userId: string, tenantId: string, seq: number) {
		const watcher = await TurnWatcher.open(this, tenantId, currentTurnId(this), { lastEventId: String(seq), overHttp: true });
		modelScenarioOf(this).watcher = watcher;
		await watcher.until(() => watcher.events.length >= 2, "the replayed events");
	},
);

When(
	"user {string} of tenant {string} reconnects to the turn over HTTP with Last-Event-ID {int}",
	async function (this: ChatticusWorld, _userId: string, tenantId: string, seq: number) {
		modelScenarioOf(this).watcher = await TurnWatcher.open(this, tenantId, currentTurnId(this), {
			lastEventId: String(seq),
			overHttp: true,
		});
	},
);

Then("committed events 3 and 4 are replayed once in order", function (this: ChatticusWorld) {
	assert.deepEqual(
		watcherOf(this).events.map((event) => event.seq),
		[3, 4],
	);
});

Then("later events continue from the same turn", async function (this: ChatticusWorld) {
	await completeTurnWith(this, "Hello!");
	const watcher = watcherOf(this);
	await watcher.until(() => watcher.events.some((event) => event.kind === "turn.completed"), "the terminal event");
	assert.equal(watcher.events.filter((event) => event.kind === "turn.completed").length, 1);
	assert.deepEqual(
		watcher.events.map((event) => event.seq),
		[3, 4, 5],
	);
});

Then("the turn completes whether or not a watcher remains connected", async function (this: ChatticusWorld) {
	const turn = await getTurn(this.turnDependencies(), openChannelOf(this).tenantId, currentTurnId(this));
	assert.equal(turn.status, "completed");
});

When(
	"user {string} of tenant {string} lists turn events after seq {int}",
	async function (this: ChatticusWorld, _userId: string, _tenantId: string, seq: number) {
		this.listedTurnEvents = await listEvents(this, seq);
	},
);

Then("the turn listing contains only events {int} and {int} in order", function (this: ChatticusWorld, start: number, end: number) {
	assert.deepEqual(
		this.listedTurnEvents.map((event) => event.seq),
		[start, end],
	);
});

When("tenant {string} tries to open the turn stream", async function (this: ChatticusWorld, tenantId: string) {
	this.streamRefusal = await TurnWatcher.request(this, tenantId, currentTurnId(this));
});

Then("turn stream access is denied because the tenant does not match", async function (this: ChatticusWorld) {
	assert.ok(this.streamRefusal, "No stream was requested");
	const refusal = await recordResponse(this.streamRefusal);
	assert.equal(refusal.status, 403, refusal.text);
	assert.match(refusal.json.detail, /Tenant 'other' cannot read turn/);
});

Then('user {string} receives a waiting server-sent event naming {word}', async function (this: ChatticusWorld, _userId: string, gate: string) {
	const watcher = watcherOf(this);
	await watcher.until(() => watcher.events.some((event) => event.kind === "turn.waiting"), "the waiting event");
	assert.equal(watcher.events.find((event) => event.kind === "turn.waiting")!.payload.body, gate);
});

Then("the turn remains active", async function (this: ChatticusWorld) {
	const turn = await getTurn(this.turnDependencies(), openChannelOf(this).tenantId, currentTurnId(this));
	assert.equal(turn.status, "active");
	if (turn.waitingFor !== null) {
		assert.equal(turn.claimedBy, null, "a parked turn must hold no claim");
	}
});

Then("the turn is still waiting on the browser gate", async function (this: ChatticusWorld) {
	const turn = await getTurn(this.turnDependencies(), openChannelOf(this).tenantId, currentTurnId(this));
	assert.equal(turn.waitingFor, "browser");
});

async function readTurnPayload(world: ChatticusWorld): Promise<Record<string, any>> {
	const response = await recordResponse(await memberGet(world, `/orgs/${openChannelOf(world).tenantId}/turns/${currentTurnId(world)}`));
	assert.equal(response.status, 200, response.text);
	return response.json;
}

Then("user {string} can read the turn gate as {word} without opening SSE", async function (this: ChatticusWorld, _userId: string, gate: string) {
	const payload = await readTurnPayload(this);
	assert.equal(payload.status, "active");
	assert.equal(payload.waiting_for, gate);
});

Then(
	"user {string} can read the pending computer tool {word} for {word}",
	async function (this: ChatticusWorld, _userId: string, toolName: string, gate: string) {
		const pending = (await readTurnPayload(this)).pending_computer_tool;
		assert.ok(pending, "The turn exposes no pending computer tool");
		assert.equal(pending.tool_name, toolName);
		assert.deepEqual(pending.arguments, { gate });
		assert.ok(pending.action_id);
	},
);

async function waitingJournalEvent(world: ChatticusWorld): Promise<Record<string, any>> {
	const waiting = (await listEvents(world, 0)).filter((event) => event.kind === "turn.waiting");
	assert.equal(waiting.length, 1);
	return waiting[0]!;
}

Then("the waiting journal event names {word} for {word}", async function (this: ChatticusWorld, toolName: string, gate: string) {
	const journal = (await waitingJournalEvent(this)).pending_computer_tool;
	assert.ok(journal, "The journal event carries no pending computer tool");
	assert.equal(journal.tool_name, toolName);
	assert.deepEqual(journal.arguments, { gate });
	assert.ok(journal.action_id);
	const streamed = watcherOf(this).events.find((event) => event.kind === "turn.waiting")?.payload.pending_computer_tool;
	assert.ok(streamed, "The streamed waiting event carries no pending computer tool");
	assert.equal(streamed.tool_name, toolName);
	assert.deepEqual(streamed.arguments, { gate });
	assert.equal(streamed.action_id, journal.action_id);
});

Then("user {string} reads the same action identifier from GET and the journal", async function (this: ChatticusWorld, _userId: string) {
	const first = (await readTurnPayload(this)).pending_computer_tool.action_id;
	const second = (await readTurnPayload(this)).pending_computer_tool.action_id;
	assert.ok(first);
	assert.equal(second, first);
	assert.equal((await waitingJournalEvent(this)).pending_computer_tool.action_id, first);
});

Given("the worker completes the turn with the answer {string}", async function (this: ChatticusWorld, answer: string) {
	await completeTurnWith(this, answer);
});

Given("the worker fails the turn with the reason {string}", async function (this: ChatticusWorld, reason: string) {
	await failTurn(this.turnDependencies(), openChannelOf(this).tenantId, currentTurnId(this), attemptOf(this), reason);
});

Given("the stored events of the turn have expired", async function (this: ChatticusWorld) {
	const expired = await this.messagingTable.expireItemsWithSortKeyPrefix(
		turnItemPartitionKey(openChannelOf(this).tenantId, currentTurnId(this)),
		"evt#",
	);
	assert.ok(expired > 0, "The turn had no stored events to expire");
	assert.deepEqual(await listEvents(this, 0), []);
});

When(
	"user {string} of tenant {string} opens the turn stream over HTTP with Last-Event-ID {string}",
	async function (this: ChatticusWorld, _userId: string, tenantId: string, lastEventId: string) {
		this.streamRefusal = await TurnWatcher.request(this, tenantId, currentTurnId(this), { lastEventId, overHttp: true });
	},
);

Then("the turn stream is refused with status {int}", function (this: ChatticusWorld, status: number) {
	assert.ok(this.streamRefusal, "No stream was requested");
	assert.equal(this.streamRefusal.status, status);
	assert.notEqual(this.streamRefusal.headers.get("content-type"), "text/event-stream");
});

Then("the stream delivered only the completed event with sequence {int}", async function (this: ChatticusWorld, seq: number) {
	const watcher = watcherOf(this);
	await letStreamTimePassUntilClosed(this, watcher);
	assert.deepEqual(
		watcher.events.map((event) => [event.kind, event.seq]),
		[["turn.completed", seq]],
	);
});

Then("the stream delivered one synthesized terminal event {string}", async function (this: ChatticusWorld, kind: string) {
	const watcher = watcherOf(this);
	await watcher.untilClosed();
	assert.equal(watcher.events.length, 1);
	assert.equal(watcher.events[0]!.kind, kind);
	const turn = await getTurn(this.turnDependencies(), openChannelOf(this).tenantId, currentTurnId(this));
	assert.equal(watcher.events[0]!.seq, turn.nextEventSeq - 1);
	if (kind === "turn.completed") {
		assert.equal(watcher.events[0]!.payload.message_seq, turn.messageSeq);
	}
});

Then(
	"the stream delivered one synthesized terminal event {string} with the reason {string}",
	async function (this: ChatticusWorld, kind: string, reason: string) {
		const watcher = watcherOf(this);
		await watcher.untilClosed();
		assert.deepEqual(
			watcher.events.map((event) => [event.kind, event.payload.body]),
			[[kind, reason]],
		);
	},
);

Then(
	"the first frame is the event {string} with id {int} and data carrying the same sequence in that order",
	async function (this: ChatticusWorld, kind: string, id: number) {
		const watcher = watcherOf(this);
		await watcher.until(() => watcher.frames.length >= 1, "the first frame");
		assert.match(watcher.rawText, new RegExp(`^event: ${kind.replace(".", "\\.")}\\nid: ${id}\\ndata: \\{.*\\}\\n\\n`));
		assert.equal(watcher.events[0]!.payload.seq, id);
		assert.equal(watcher.events[0]!.payload.kind, kind);
	},
);

Given("the turn streams run on a controlled clock", function (this: ChatticusWorld) {
	this.streamClock.takeControl();
});

When("{int} seconds pass on the turn stream clock", async function (this: ChatticusWorld, seconds: number) {
	const controlled = this.streamClock.controlledClock;
	assert.ok(controlled, "The turn streams do not run on a controlled clock");
	await controlled.advance(seconds * 1000);
});

Then("the watcher has received {int} heartbeat comment(s)", async function (this: ChatticusWorld, count: number) {
	const watcher = watcherOf(this);
	await watcher.until(() => watcher.heartbeats >= count, `${count} heartbeat comments`);
	assert.equal(watcher.heartbeats, count);
});

Then("the watcher received no terminal event", function (this: ChatticusWorld) {
	const terminal = watcherOf(this).events.filter((event) => ["turn.completed", "turn.failed", "turn.reconciling"].includes(event.kind));
	assert.deepEqual(terminal, []);
});

Then("the watcher received one reconciling event carrying sequence {int}", async function (this: ChatticusWorld, seq: number) {
	const watcher = watcherOf(this);
	await watcher.untilClosed();
	const reconciling = watcher.events.filter((event) => event.kind === "turn.reconciling");
	assert.equal(reconciling.length, 1);
	assert.equal(reconciling[0]!.seq, seq);
	assert.equal(watcher.events[watcher.events.length - 1], reconciling[0]);
});

Then("the watcher is still connected", function (this: ChatticusWorld) {
	assert.equal(watcherOf(this).closed, false);
});
