import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { latestTurnForChannel } from "../../src/domain/turns.ts";
import { claimTurnAttempt } from "../../src/turn/executor.ts";
import { type CrashWindow, SimulatedCrash, TURN_BOUNDARIES, type TurnBoundary } from "../../src/turn/fault-plan.ts";
import { executorDepsFor, modelScenarioOf } from "../executor-harness.ts";
import { TURN_RUN_QUEUE } from "../turn-queues.ts";
import {
	authoritativeWorkers,
	currentTurnId,
	deliverDueProbes,
	openChannel,
	passTimeUntilSettled,
	postToBot,
	RECOVERY_ROUND_SECONDS,
	runQueuedJobs,
	turnNow,
} from "../turn-recovery.ts";
import type { ChatticusWorld } from "../world.ts";
import { resetScenarioToEmptyControlPlane } from "./bot.steps.ts";
import { readChannelMessages } from "./model.steps.ts";
import { openChannelWithNamedBot } from "./message.steps.ts";

type FaultScenario = { boundary: TurnBoundary | null; window: CrashWindow | null };

const scenarios = new WeakMap<ChatticusWorld, FaultScenario>();

const FAULT_TUNING = { tokenFlushBytes: 1_000_000, tokenFlushMilliseconds: 3_600_000 };

function faultOf(world: ChatticusWorld): { boundary: TurnBoundary; window: CrashWindow } {
	const scenario = scenarios.get(world);
	assert.ok(scenario?.boundary && scenario.window, "The harness has not armed a crash");
	return { boundary: scenario.boundary, window: scenario.window };
}

function boundaryNamed(name: string): TurnBoundary {
	const boundary = TURN_BOUNDARIES.find((candidate) => candidate === name);
	assert.ok(boundary, `Unknown boundary ${name}`);
	return boundary;
}

function windowNamed(name: string): CrashWindow {
	assert.ok(name === "before" || name === "after", `Unknown crash window ${name}`);
	return name;
}

Given(
	"a turn fault harness for tenant {string} user {string}",
	async function (this: ChatticusWorld, tenantId: string, userId: string) {
		await resetScenarioToEmptyControlPlane(this);
		await openChannelWithNamedBot(this, tenantId, userId, "Assistant");
		modelScenarioOf(this).scripted.reply("The one answer the model gives.");
		scenarios.set(this, { boundary: null, window: null });
	},
);

Given("the harness arms a crash {word} {word}", function (this: ChatticusWorld, window: string, boundary: string) {
	scenarios.set(this, { boundary: boundaryNamed(boundary), window: windowNamed(window) });
});

When("the harness drives the turn until the crash", async function (this: ChatticusWorld) {
	const { boundary, window } = faultOf(this);
	const plan = this.faultPlan;
	if (boundary === "message_commit" || boundary === "logical_enqueue") {
		plan.arm(boundary, window);
		await assert.rejects(postToBot(this, "Assistant", "hello"), SimulatedCrash);
	} else if (boundary === "deadline_recovery") {
		const turnId = await postToBot(this, "Assistant", "hello");
		const bot = this.botsByName?.get("Assistant");
		assert.ok(bot);
		this.queues.take(TURN_RUN_QUEUE, (body) => (body as { turnId: string }).turnId === turnId);
		const deps = await executorDepsFor(this, modelScenarioOf(this));
		const claim = await claimTurnAttempt(
			{ ...deps, workerLabel: "worker-a" },
			{ tenantId: openChannel(this).tenantId, turnId, botId: bot.botId },
		);
		assert.ok(claim, "The worker could not claim the turn");
		this.clock.advanceSeconds(RECOVERY_ROUND_SECONDS);
		plan.arm(boundary, window);
		await assert.rejects(deliverDueProbes(this), SimulatedCrash);
	} else {
		await postToBot(this, "Assistant", "hello");
		plan.arm(boundary, window);
		await assert.rejects(runQueuedJobs(this, { tuning: FAULT_TUNING }), SimulatedCrash);
	}
	assert.deepEqual(plan.crashedAt, { boundary, window }, "The crash did not happen where it was armed");
});

When("the harness recovers and completes the turn", async function (this: ChatticusWorld) {
	const channel = openChannel(this);
	this.faultPlan.clear();
	const bot = this.botsByName?.get("Assistant");
	assert.ok(bot);
	const started = await latestTurnForChannel(this.turnDependencies(), channel.tenantId, channel.channelId, bot.botId);
	if (started === null) {
		await postToBot(this, "Assistant", "hello");
	} else {
		this.lastTurnId = started.turnId;
	}
	await passTimeUntilSettled(this, currentTurnId(this), { tuning: FAULT_TUNING });
	await runQueuedJobs(this, { tuning: FAULT_TUNING });
});

Then("provider calls equal {int}", function (this: ChatticusWorld, count: number) {
	assert.equal(modelScenarioOf(this).scripted.callCount, count);
});

Then("the channel has one human message and one bot answer", async function (this: ChatticusWorld) {
	const messages = await readChannelMessages(this);
	assert.equal(messages.filter((message) => message.author_kind === "human").length, 1);
	const answers = messages.filter((message) => message.author_kind === "bot");
	assert.deepEqual(
		answers.map((message) => message.body),
		["The one answer the model gives."],
	);
});

Then("the turn status is completed", async function (this: ChatticusWorld) {
	assert.equal((await turnNow(this)).status, "completed");
});

Then("at most one worker is authoritative", async function (this: ChatticusWorld) {
	const turn = await turnNow(this);
	assert.ok(authoritativeWorkers(turn, this.clock.now()).length <= 1);
	assert.equal(turn.status === "active", false);
});
