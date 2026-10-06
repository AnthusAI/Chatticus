import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { allocateSeq } from "../../src/pi/mailbox.ts";
import {
	appendTurnEvent,
	claimTurn,
	completeTurn,
	getTurn,
	releaseForWaiting,
	type TurnClaim,
} from "../../src/domain/turns.ts";
import type { TurnRunJob } from "../../src/domain/turn-admission.ts";
import { StaleAttemptError, statusFor } from "../../src/http/errors.ts";
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

function currentTurnId(world: ChatticusWorld): string {
	assert.ok(world.lastTurnId, "The last post started no turn");
	return world.lastTurnId;
}

async function channelHuman(world: ChatticusWorld): Promise<string> {
	const channel = openChannelOf(world);
	const response = await recordResponse(await memberGet(world, `/orgs/${channel.tenantId}/channels/${channel.channelId}`));
	assert.equal(response.status, 200, response.text);
	return response.json.user_id;
}

async function postToBot(world: ChatticusWorld, botName: string, body: string, enqueueTurn: boolean): Promise<void> {
	const channel = openChannelOf(world);
	const payload: Record<string, unknown> = {
		author_kind: "human",
		author_id: await channelHuman(world),
		body,
		addressed_to_bot_id: botNamed(world, botName).botId,
	};
	if (!enqueueTurn) {
		payload.enqueue_turn = false;
	}
	const response = await recordResponse(
		await memberPost(world, `/orgs/${channel.tenantId}/channels/${channel.channelId}/messages`, payload),
	);
	assert.equal(response.status, 200, response.text);
	world.lastTurnId = response.json.turn_id;
}

async function claimAs(world: ChatticusWorld, tenantId: string, turnId: string, owner: string): Promise<TurnClaim | null> {
	return claimTurn(world.turnDependencies(), tenantId, turnId, world.ids.next(), owner);
}

async function completeAs(world: ChatticusWorld, tenantId: string, turnId: string, attemptId: string, body: string) {
	const turn = await getTurn(world.turnDependencies(), tenantId, turnId);
	const messageSeq = await allocateSeq(
		{ client: world.messagingTable.client, tableName: world.messagingTable.tableName },
		tenantId,
		turn.channelId,
	);
	return completeTurn(world.turnDependencies(), tenantId, turnId, attemptId, messageSeq, body);
}

async function turnEvents(world: ChatticusWorld, tenantId: string, turnId: string): Promise<Array<Record<string, any>>> {
	const response = await recordResponse(await memberGet(world, `/orgs/${tenantId}/turns/${turnId}/events`));
	assert.equal(response.status, 200, response.text);
	return response.json.events;
}

async function rejection(operation: () => Promise<unknown>): Promise<Error> {
	try {
		await operation();
	} catch (error) {
		assert.ok(error instanceof Error);
		return error;
	}
	assert.fail("The operation was accepted");
}

async function readChannelTurn(world: ChatticusWorld, tenantId: string, suffix: string): Promise<RecordedResponse> {
	const channel = openChannelOf(world);
	return recordResponse(await memberGet(world, `/orgs/${tenantId}/channels/${channel.channelId}/${suffix}`));
}

Given("one unfinished turn job is delivered twice", async function (this: ChatticusWorld) {
	await postToBot(this, "Assistant", "ping", true);
	const bot = botNamed(this, "Assistant");
	const jobs = this.queues
		.pending(TURN_RUN_QUEUE)
		.map((queued) => queued.body as TurnRunJob)
		.filter((job) => job.botId === bot.botId);
	assert.equal(jobs.length, 1);
	this.deliveredTurnJobs = [jobs[0]!, jobs[0]!].map((job) => ({ tenantId: job.tenantId, turnId: job.turnId }));
	this.modelAttemptCount = 0;
});

When("two workers try to process it concurrently", async function (this: ChatticusWorld) {
	this.turnClaimOutcomes = await Promise.all(
		this.deliveredTurnJobs.map(async (job, index) => {
			const claim = await claimAs(this, job.tenantId, job.turnId, `worker-${index + 1}`);
			if (claim !== null) {
				this.modelAttemptCount += 1;
			}
			return { worker: `worker-${index + 1}`, attemptId: claim === null ? null : claim.attemptId };
		}),
	);
});

Then("only one worker begins the model attempt", function (this: ChatticusWorld) {
	assert.equal(this.modelAttemptCount, 1);
	assert.equal(this.turnClaimOutcomes.filter((outcome) => outcome.attemptId !== null).length, 1);
});

Then("only that attempt can append progress or completion", async function (this: ChatticusWorld) {
	const winner = this.turnClaimOutcomes.find((outcome) => outcome.attemptId !== null);
	assert.ok(winner?.attemptId);
	const job = this.deliveredTurnJobs[0]!;
	const stranger = this.ids.next();
	const progressError = await rejection(() =>
		appendTurnEvent(this.turnDependencies(), job.tenantId, job.turnId, stranger, { kind: "turn.token", token: "extra" }),
	);
	assert.ok(progressError instanceof StaleAttemptError);
	const completionError = await rejection(() => completeAs(this, job.tenantId, job.turnId, stranger, "extra"));
	assert.ok(completionError instanceof StaleAttemptError);
	const accepted = await appendTurnEvent(this.turnDependencies(), job.tenantId, job.turnId, winner.attemptId, {
		kind: "turn.token",
		token: "progress",
	});
	assert.equal(accepted.token, "progress");
	this.turnAttempts.set("owner", winner.attemptId);
});

Then("the channel receives at most one final answer", async function (this: ChatticusWorld) {
	const job = this.deliveredTurnJobs[0]!;
	const owner = this.turnAttempts.get("owner");
	assert.ok(owner);
	await completeAs(this, job.tenantId, job.turnId, owner, "final answer");
	const loser = await rejection(() => completeAs(this, job.tenantId, job.turnId, this.ids.next(), "second answer"));
	assert.ok(loser instanceof StaleAttemptError);
	const completions = (await turnEvents(this, job.tenantId, job.turnId)).filter((event) => event.kind === "turn.completed");
	assert.equal(completions.length, 1);
	assert.equal(completions[0]!.body, "final answer");
});

Given("a turn has been reassigned to a newer attempt", async function (this: ChatticusWorld) {
	await postToBot(this, "Assistant", "ping", true);
	const channel = openChannelOf(this);
	const turnId = currentTurnId(this);
	const first = await claimAs(this, channel.tenantId, turnId, "worker-a");
	assert.ok(first, "The first worker could not claim the turn");
	this.clock.advanceSeconds(61);
	const second = await claimAs(this, channel.tenantId, turnId, "worker-b");
	assert.ok(second, "The second worker could not claim the expired turn");
	assert.notEqual(second.attemptId, first.attemptId);
	this.turnAttempts.set("stale", first.attemptId);
	this.turnAttempts.set("current", second.attemptId);
});

When("the expired attempt tries to append output or execute an action", async function (this: ChatticusWorld) {
	const channel = openChannelOf(this);
	const turnId = currentTurnId(this);
	const stale = this.turnAttempts.get("stale");
	assert.ok(stale);
	this.turnOperationErrors = [
		await rejection(() =>
			appendTurnEvent(this.turnDependencies(), channel.tenantId, turnId, stale, { kind: "turn.token", token: "late" }),
		),
		await rejection(() =>
			appendTurnEvent(this.turnDependencies(), channel.tenantId, turnId, stale, {
				kind: "tool.call",
				body: "late tool",
				actionId: "late-action",
			}),
		),
	];
});

Then("the operation is rejected", function (this: ChatticusWorld) {
	assert.equal(this.turnOperationErrors.length, 2);
	for (const error of this.turnOperationErrors) {
		assert.ok(error instanceof StaleAttemptError, String(error));
		assert.equal(statusFor(error), 409);
	}
});

Then("only the newer attempt can change the turn", async function (this: ChatticusWorld) {
	const channel = openChannelOf(this);
	const turnId = currentTurnId(this);
	const current = this.turnAttempts.get("current");
	assert.ok(current);
	await appendTurnEvent(this.turnDependencies(), channel.tenantId, turnId, current, { kind: "turn.token", token: "ok" });
	await completeAs(this, channel.tenantId, turnId, current, "ok");
});

Then("the user sees no duplicate output or action", async function (this: ChatticusWorld) {
	const channel = openChannelOf(this);
	const events = await turnEvents(this, channel.tenantId, currentTurnId(this));
	assert.deepEqual(
		events.filter((event) => event.kind === "turn.token").map((event) => event.token),
		["ok"],
	);
	assert.equal(events.filter((event) => event.kind === "tool.call").length, 0);
	assert.equal(events.filter((event) => event.kind === "turn.completed").length, 1);
	assert.deepEqual(
		events.map((event) => event.seq),
		events.map((_event, index) => index + 1),
	);
});

Then("tenant {string} can read the active turn on the open channel", async function (this: ChatticusWorld, tenantId: string) {
	const channel = openChannelOf(this);
	const response = await readChannelTurn(this, tenantId, "turn");
	assert.equal(response.status, 200, response.text);
	assert.equal(response.json.turn_id, currentTurnId(this));
	assert.equal(response.json.channel_id, channel.channelId);
	assert.equal(response.json.status, "active");
});

Then("tenant {string} can read the turn by identifier", async function (this: ChatticusWorld, tenantId: string) {
	const channel = openChannelOf(this);
	const turnId = currentTurnId(this);
	const response = await recordResponse(await memberGet(this, `/orgs/${tenantId}/turns/${turnId}`));
	assert.equal(response.status, 200, response.text);
	assert.equal(response.json.turn_id, turnId);
	assert.equal(response.json.channel_id, channel.channelId);
	assert.equal(response.json.status, "active");
	const other = await recordResponse(await memberGet(this, `/orgs/other/turns/${turnId}`));
	assert.equal(other.status, 403, other.text);
});

When("the worker claims the fence probe turn and completes it through HTTP", async function (this: ChatticusWorld) {
	const channel = openChannelOf(this);
	const turnId = currentTurnId(this);
	const claim = await claimAs(this, channel.tenantId, turnId, "fence-probe-worker");
	assert.ok(claim, "The worker could not claim the fence probe turn");
	await completeAs(this, channel.tenantId, turnId, claim.attemptId, "Fence probe complete.");
});

Then("tenant {string} cannot read an active turn on the open channel", async function (this: ChatticusWorld, tenantId: string) {
	const response = await readChannelTurn(this, tenantId, "turn");
	assert.equal(response.status, 404, response.text);
});

When("the open turn is remembered as {string}", function (this: ChatticusWorld, label: string) {
	this.rememberedTurnIds.set(label, currentTurnId(this));
});

When("a worker claims the turn remembered as {string}", async function (this: ChatticusWorld, label: string) {
	const channel = openChannelOf(this);
	const turnId = this.rememberedTurnIds.get(label);
	assert.ok(turnId, `No turn is remembered as ${label}`);
	const claim = await claimAs(this, channel.tenantId, turnId, "overlap-worker");
	assert.ok(claim, "The worker could not claim the remembered turn");
});

Then("the latest turn on the open channel is addressed to bot {string}", async function (this: ChatticusWorld, name: string) {
	const channel = openChannelOf(this);
	const response = await readChannelTurn(this, channel.tenantId, "turns/latest");
	assert.equal(response.status, 200, response.text);
	assert.equal(response.json.bot_id, botNamed(this, name).botId);
});

When("tenant {string} reads the latest turn on the open channel", async function (this: ChatticusWorld, tenantId: string) {
	this.latestTurnResponse = await readChannelTurn(this, tenantId, "turns/latest");
});

Then("the latest turn is not found", function (this: ChatticusWorld) {
	assert.ok(this.latestTurnResponse, "No latest turn was requested");
	assert.ok([403, 404].includes(this.latestTurnResponse.status), this.latestTurnResponse.text);
});

Given(
	"user {string} of tenant {string} has an active turn on the channel",
	async function (this: ChatticusWorld, _userId: string, tenantId: string) {
		await postToBot(this, "Researcher", "ping", true);
		const claim = await claimAs(this, tenantId, currentTurnId(this), "gate-worker");
		assert.ok(claim, "The worker could not claim the active turn");
		this.turnAttempts.set("current", claim.attemptId);
	},
);

When("the worker posts a progress chunk and then waits on the browser gate", async function (this: ChatticusWorld) {
	const channel = openChannelOf(this);
	const turnId = currentTurnId(this);
	const attempt = this.turnAttempts.get("current");
	assert.ok(attempt, "No worker has claimed the turn");
	await appendTurnEvent(this.turnDependencies(), channel.tenantId, turnId, attempt, {
		kind: "turn.token",
		token: "Here is a draft.",
	});
	await releaseForWaiting(this.turnDependencies(), channel.tenantId, turnId, attempt, "browser");
});

Then(
	"tenant {string} can read the waiting turn on the open channel as {word}",
	async function (this: ChatticusWorld, tenantId: string, gate: string) {
		const channel = openChannelOf(this);
		const response = await readChannelTurn(this, tenantId, "turn");
		assert.equal(response.status, 200, response.text);
		assert.equal(response.json.turn_id, currentTurnId(this));
		assert.equal(response.json.channel_id, channel.channelId);
		assert.equal(response.json.status, "active");
		assert.equal(response.json.waiting_for, gate);
		const pending = response.json.pending_computer_tool;
		assert.ok(pending);
		assert.equal(pending.tool_name, "request_computer_capability");
		assert.deepEqual(pending.arguments, { gate });
		assert.ok(pending.action_id);
	},
);
