import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { allocateSeq } from "../../src/pi/mailbox.ts";
import { executeTurn } from "../../src/turn/executor.ts";
import type { TurnExecutionOutcome } from "../../src/turn/types.ts";
import { executorDepsFor, modelScenarioOf, startBotTurn } from "../executor-harness.ts";
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

export function openChannelOf(world: ChatticusWorld): { channelId: string; tenantId: string } {
	assert.ok(world.lastChannel, "No channel has been opened");
	return world.lastChannel;
}

export function botNamed(world: ChatticusWorld, name: string): { botId: string; name: string; tenantId: string } {
	const bot = world.botsByName?.get(name);
	assert.ok(bot, `Bot ${name} not found`);
	return bot;
}

export function currentTurnId(world: ChatticusWorld): string {
	assert.ok(world.lastTurnId, "The last post started no turn");
	return world.lastTurnId;
}

async function channelHuman(world: ChatticusWorld): Promise<string> {
	const channel = openChannelOf(world);
	const response = await recordResponse(await memberGet(world, `/orgs/${channel.tenantId}/channels/${channel.channelId}`));
	assert.equal(response.status, 200, response.text);
	return response.json.user_id;
}

export async function postToBot(world: ChatticusWorld, botName: string, body: string, enqueueTurn: boolean): Promise<void> {
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

export async function claimAs(world: ChatticusWorld, tenantId: string, turnId: string, owner: string): Promise<TurnClaim | null> {
	return claimTurn(world.turnDependencies(), tenantId, turnId, world.ids.next(), owner);
}

export async function completeAs(world: ChatticusWorld, tenantId: string, turnId: string, attemptId: string, body: string) {
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

async function channelMessages(world: ChatticusWorld): Promise<Array<Record<string, any>>> {
	const channel = openChannelOf(world);
	const response = await recordResponse(await memberGet(world, `/orgs/${channel.tenantId}/channels/${channel.channelId}/messages`));
	assert.equal(response.status, 200, response.text);
	return response.json.messages;
}

async function eventually(condition: () => boolean, description: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!condition()) {
		assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
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
});

When("two workers try to process it concurrently", async function (this: ChatticusWorld) {
	const scenario = modelScenarioOf(this);
	scenario.scripted.reply("final answer");
	const hold = scenario.scripted.slow();
	const bot = botNamed(this, "Assistant");
	const finished: TurnExecutionOutcome[] = [];
	const runs = this.deliveredTurnJobs.map(async (job, index) =>
		executeTurn(
			{ tenantId: job.tenantId, turnId: job.turnId, botId: bot.botId },
			{ ...(await executorDepsFor(this, scenario)), workerLabel: `worker-${index + 1}` },
		).then((outcome) => {
			finished.push(outcome);
			return outcome;
		}),
	);
	await hold.reached;
	await eventually(() => finished.length === 1, "the worker that did not win the claim to give up");
	hold.release();
	scenario.outcomes.push(...(await Promise.all(runs)));
});

Then("only one worker begins the model attempt", async function (this: ChatticusWorld) {
	const scenario = modelScenarioOf(this);
	assert.equal(scenario.scripted.callCount, 1);
	assert.deepEqual([...scenario.outcomes].sort(), ["done", "lost"]);
	const job = this.deliveredTurnJobs[0]!;
	const turn = await getTurn(this.turnDependencies(), job.tenantId, job.turnId);
	assert.equal(turn.attempt, 1);
});

Then("only that attempt can append progress or completion", async function (this: ChatticusWorld) {
	const job = this.deliveredTurnJobs[0]!;
	const turn = await getTurn(this.turnDependencies(), job.tenantId, job.turnId);
	assert.ok(turn.attemptId);
	const claims = (await turnEvents(this, job.tenantId, job.turnId)).filter((event) => event.kind === "attempt.claimed");
	assert.deepEqual(
		claims.map((event) => event.attempt_id),
		[turn.attemptId],
	);
	const stranger = this.ids.next();
	const progressError = await rejection(() =>
		appendTurnEvent(this.turnDependencies(), job.tenantId, job.turnId, stranger, { kind: "turn.token", token: "extra" }),
	);
	assert.ok(progressError instanceof StaleAttemptError);
	const completionError = await rejection(() => completeAs(this, job.tenantId, job.turnId, stranger, "extra"));
	assert.ok(completionError instanceof StaleAttemptError);
	this.turnAttempts.set("owner", turn.attemptId);
});

Then("the channel receives at most one final answer", async function (this: ChatticusWorld) {
	const job = this.deliveredTurnJobs[0]!;
	const completions = (await turnEvents(this, job.tenantId, job.turnId)).filter((event) => event.kind === "turn.completed");
	assert.equal(completions.length, 1);
	assert.equal(completions[0]!.body, "final answer");
	const answers = (await channelMessages(this)).filter((message) => message.author_kind === "bot");
	assert.deepEqual(
		answers.map((message) => message.body),
		["final answer"],
	);
	assert.equal(answers[0]!.seq, completions[0]!.message_seq);
});

Given("a turn has been reassigned to a newer attempt", async function (this: ChatticusWorld) {
	await postToBot(this, "Assistant", "ping", true);
	const channel = openChannelOf(this);
	const turnId = currentTurnId(this);
	const scenario = modelScenarioOf(this);
	scenario.scripted.reply("Answer from the first attempt").reply("Answer from the newer attempt");
	const hold = scenario.scripted.slow();
	scenario.hold = hold;
	let openRenewals: () => void = () => undefined;
	const renewalGate = new Promise<void>((resolve) => {
		openRenewals = resolve;
	});
	scenario.openRenewals = openRenewals;
	const first = startBotTurn(this, "Assistant", undefined, { renewalGate });
	await hold.reached;
	const stale = (await getTurn(this.turnDependencies(), channel.tenantId, turnId)).attemptId;
	assert.ok(stale, "The first worker could not claim the turn");
	this.clock.advanceSeconds(61);
	const second = await executeTurn(
		{ tenantId: channel.tenantId, turnId, botId: botNamed(this, "Assistant").botId },
		await executorDepsFor(this, scenario),
	);
	assert.equal(second, "done");
	const current = (await getTurn(this.turnDependencies(), channel.tenantId, turnId)).attemptId;
	assert.ok(current);
	assert.notEqual(current, stale);
	this.turnAttempts.set("stale", stale);
	this.turnAttempts.set("current", current);
	scenario.firstAttempt = first;
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
	const scenario = modelScenarioOf(this);
	scenario.hold?.release();
	scenario.openRenewals?.();
	assert.ok(scenario.firstAttempt, "The first attempt was never started");
	assert.equal(await scenario.firstAttempt, "lost");
	const turn = await getTurn(this.turnDependencies(), channel.tenantId, turnId);
	assert.equal(turn.attemptId, current);
	assert.equal(turn.status, "completed");
});

Then("the user sees no duplicate output or action", async function (this: ChatticusWorld) {
	const channel = openChannelOf(this);
	const events = await turnEvents(this, channel.tenantId, currentTurnId(this));
	assert.equal(
		events
			.filter((event) => event.kind === "turn.token")
			.map((event) => event.token)
			.join(""),
		"Answer from the newer attempt",
	);
	assert.equal(events.filter((event) => event.kind === "tool.call").length, 0);
	assert.equal(events.filter((event) => event.kind === "turn.completed").length, 1);
	assert.deepEqual(
		events.map((event) => event.seq),
		events.map((_event, index) => index + 1),
	);
	const answers = (await channelMessages(this)).filter((message) => message.author_kind === "bot");
	assert.deepEqual(
		answers.map((message) => message.body),
		["Answer from the newer attempt"],
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
