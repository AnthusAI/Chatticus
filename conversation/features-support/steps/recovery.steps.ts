import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { appendTurnEvent } from "../../src/domain/turns.ts";
import { renewAttempt, claimTurnAttempt, executeTurn } from "../../src/turn/executor.ts";
import { COMPUTER_UNAVAILABLE_REASON, finalizeEnqueueId, logicalEnqueueId, RECOVERY_EXHAUSTED_REASON, requestLogicalEnqueue } from "../../src/turn/probes.ts";
import { parkAttempt } from "../../src/turn/yield.ts";
import { UNCERTAIN_COMMIT_REASON } from "../../src/turn/executor.ts";
import { SimulatedCrash } from "../../src/turn/fault-plan.ts";
import { executorDepsFor, modelScenarioOf, startBotTurn } from "../executor-harness.ts";
import { TurnWatcher } from "../turn-watcher.ts";
import { runQueueOf, runVisibilityOf, TURN_RUN_QUEUE } from "../turn-queues.ts";
import {
	currentTurnId,
	deliverDueProbes,
	eventuallyTrue,
	openChannel,
	postToBot,
	queuedProbeDelaysFor,
	queuedProbesFor,
	queuedRunsFor,
	retireFrozenWorker,
	runQueuedJobs,
	setRecoveryAttempts,
	turnNow,
} from "../turn-recovery.ts";
import type { ChatticusWorld } from "../world.ts";
import { resetScenarioToEmptyControlPlane } from "./bot.steps.ts";
import { readChannelMessages, readTurnEvents } from "./model.steps.ts";

type RecoveryScenario = {
	partialEventCount: number;
	ownerAttemptId: string | null;
	leaseBefore: Date | null;
	recoveryAttemptsBefore: number;
	logicalEnqueueIdsBefore: string[];
	visibilityExtensionsBefore: number;
};

const states = new WeakMap<ChatticusWorld, RecoveryScenario>();

function recoveryOf(world: ChatticusWorld): RecoveryScenario {
	let state = states.get(world);
	if (state === undefined) {
		state = {
			partialEventCount: 0,
			ownerAttemptId: null,
			leaseBefore: null,
			recoveryAttemptsBefore: 0,
			logicalEnqueueIdsBefore: [],
			visibilityExtensionsBefore: 0,
		};
		states.set(world, state);
	}
	return state;
}

function freezeRenewals(world: ChatticusWorld): Promise<void> {
	const scenario = modelScenarioOf(world);
	return new Promise<void>((resolve) => {
		scenario.openRenewals = resolve;
	});
}

Given("an empty control plane with turn recovery enabled", async function (this: ChatticusWorld) {
	await resetScenarioToEmptyControlPlane(this);
});

Given("a turn has committed partial progress", async function (this: ChatticusWorld) {
	const turnId = await postToBot(this, "Assistant", "hello");
	const scenario = modelScenarioOf(this);
	scenario.scripted
		.reply("The first owner begins the answer and then vanishes.")
		.reply("The answer, finished by a later attempt.");
	const hold = scenario.scripted.slowMidStream(24);
	scenario.hold = hold;
	scenario.firstAttempt = startBotTurn(this, "Assistant", undefined, { renewalGate: freezeRenewals(this) });
	await hold.reached;
	const tenantId = openChannel(this).tenantId;
	await eventuallyTrue(
		async () => (await readTurnEvents(this, tenantId, turnId)).some((event) => event.kind === "turn.token"),
		"the first owner's streamed text to be committed",
	);
	recoveryOf(this).partialEventCount = (await readTurnEvents(this, tenantId, turnId)).length;
	scenario.watcher = await TurnWatcher.open(this, tenantId, turnId);
});

Given("its active worker stops without completing", async function (this: ChatticusWorld) {
	recoveryOf(this).ownerAttemptId = (await turnNow(this)).attemptId;
	this.clock.advanceSeconds(61);
});

Given("recovery has already been attempted once", async function (this: ChatticusWorld) {
	const turnId = currentTurnId(this);
	await setRecoveryAttempts(this, openChannel(this).tenantId, turnId, 1);
	const turn = await turnNow(this, turnId);
	const state = recoveryOf(this);
	state.recoveryAttemptsBefore = turn.recoveryAttempts;
	state.logicalEnqueueIdsBefore = [...turn.logicalEnqueueIds];
});

When("the turn deadline is reached", async function (this: ChatticusWorld) {
	this.clock.advanceSeconds(61);
	await deliverDueProbes(this);
});

Then("exactly one later attempt resumes after the last committed event", async function (this: ChatticusWorld) {
	const turnId = currentTurnId(this);
	const tenantId = openChannel(this).tenantId;
	const scenario = modelScenarioOf(this);
	const resumable = await turnNow(this, turnId);
	assert.equal(resumable.status, "active");
	assert.equal(resumable.recoveryAttempts, 1);
	assert.equal(resumable.attemptId, null);
	assert.equal(queuedRunsFor(this, turnId).length, 1);
	assert.deepEqual([...resumable.logicalEnqueueIds].sort(), [logicalEnqueueId(turnId), logicalEnqueueId(turnId, 1)].sort());
	assert.equal((await readTurnEvents(this, tenantId, turnId)).length, recoveryOf(this).partialEventCount);
	assert.equal((await runQueuedJobs(this)).join(","), "done");
	const finished = await turnNow(this, turnId);
	assert.equal(finished.status, "completed");
	const events = await readTurnEvents(this, tenantId, turnId);
	assert.deepEqual(
		events.map((event) => event.seq),
		events.map((_event, index) => index + 1),
	);
	const claims = events.filter((event) => event.kind === "attempt.claimed");
	assert.equal(claims.length, 2);
	assert.notEqual(claims[0]!.attempt_id, claims[1]!.attempt_id);
	assert.ok(claims[1]!.seq > recoveryOf(this).partialEventCount, "the later attempt did not continue after the committed events");
	assert.equal(scenario.scripted.callCount, 2);
	const answers = (await readChannelMessages(this)).filter((message) => message.author_kind === "bot");
	assert.deepEqual(
		answers.map((message) => message.body),
		["The answer, finished by a later attempt."],
	);
});

Then("the turn reaches a visible failed state with a reason", async function (this: ChatticusWorld) {
	const turnId = currentTurnId(this);
	const turn = await turnNow(this, turnId);
	assert.equal(turn.status, "failed");
	assert.equal(turn.terminalReason, RECOVERY_EXHAUSTED_REASON);
	const events = await readTurnEvents(this, openChannel(this).tenantId, turnId);
	assert.equal(events.filter((event) => event.kind === "turn.failed").length, 1);
	assert.equal(queuedRunsFor(this, turnId).length, 0);
});

Then("the watcher does not remain open indefinitely", async function (this: ChatticusWorld) {
	const watcher = modelScenarioOf(this).watcher;
	assert.ok(watcher, "No one is watching the turn");
	await watcher.untilClosed();
	assert.ok(["turn.completed", "turn.failed", "turn.reconciling"].includes(watcher.events[watcher.events.length - 1]!.kind));
	await retireFrozenWorker(this);
});

Given("a turn is waiting on an ambiguous provider outcome", async function (this: ChatticusWorld) {
	await postToBot(this, "Assistant", "send the report");
	const scenario = modelScenarioOf(this);
	scenario.scripted.reply("This answer may or may not be saved.");
	const hold = scenario.scripted.slow();
	scenario.hold = hold;
	scenario.started = startBotTurn(this, "Assistant");
	await hold.reached;
});

When("recovery cannot prove the outcome", async function (this: ChatticusWorld) {
	const scenario = modelScenarioOf(this);
	assert.ok(scenario.started && scenario.hold, "No turn is waiting on the model");
	scenario.storeFault.armed = true;
	scenario.hold.release();
	scenario.lastOutcome = await scenario.started;
});

Then("the turn requests reconciliation", async function (this: ChatticusWorld) {
	const turnId = currentTurnId(this);
	assert.equal(modelScenarioOf(this).lastOutcome, "reconciling");
	const turn = await turnNow(this, turnId);
	assert.equal(turn.status, "reconciling");
	assert.equal(turn.terminalReason, UNCERTAIN_COMMIT_REASON);
	const events = await readTurnEvents(this, openChannel(this).tenantId, turnId);
	assert.equal(events[events.length - 1]!.kind, "turn.reconciling");
});

Then("the system does not silently repeat a consequential operation", async function (this: ChatticusWorld) {
	const turnId = currentTurnId(this);
	const tenantId = openChannel(this).tenantId;
	const scenario = modelScenarioOf(this);
	const callsBefore = scenario.scripted.callCount;
	this.clock.advanceSeconds(121);
	await deliverDueProbes(this);
	assert.equal(queuedRunsFor(this, turnId).length, 0, "a probe queued another run of a reconciling turn");
	const bot = this.botsByName?.get("Assistant");
	assert.ok(bot);
	const redelivered = await executeTurn({ tenantId, turnId, botId: bot.botId }, await executorDepsFor(this, scenario));
	assert.equal(redelivered, "lost");
	assert.equal(scenario.scripted.callCount, callsBefore);
	assert.equal((await turnNow(this, turnId)).status, "reconciling");
});

When("the same logical enqueue is requested twice for one turn", async function (this: ChatticusWorld) {
	const turnId = await postToBot(this, "Assistant", "hello");
	const turn = await turnNow(this, turnId);
	const deps = { recorder: this.turnControlStore(), turnRuns: runQueueOf(this) };
	const job = { tenantId: turn.tenantId, channelId: turn.channelId, botId: turn.botId, turnId, requiredCapabilities: ["cpu"] };
	const requests = [
		await requestLogicalEnqueue(deps, job, logicalEnqueueId(turnId)),
		await requestLogicalEnqueue(deps, job, logicalEnqueueId(turnId)),
	];
	assert.deepEqual(requests, [false, false]);
});

Then("only one queue delivery is recorded", function (this: ChatticusWorld) {
	assert.equal(queuedRunsFor(this, currentTurnId(this)).length, 1);
});

When("the fenced owner calls the renew API", async function (this: ChatticusWorld) {
	const state = recoveryOf(this);
	const owned = await turnNow(this);
	assert.ok(owned.attemptId, "No worker owns the turn");
	state.ownerAttemptId = owned.attemptId;
	state.leaseBefore = owned.leaseExpiresAt;
	state.visibilityExtensionsBefore = this.runVisibilityExtensions.length;
	this.clock.advanceSeconds(30);
	const renewed = await renewAttempt(
		{ turns: this.turnDependencies(), runVisibility: runVisibilityOf(this) },
		openChannel(this).tenantId,
		currentTurnId(this),
		state.ownerAttemptId,
	);
	assert.equal(renewed, true);
});

Given("an active turn is waiting for a worker", async function (this: ChatticusWorld) {
	await postToBot(this, "Assistant", "hello");
	assert.equal(queuedRunsFor(this, currentTurnId(this)).length, 1);
});

When("the computerless worker runs a slow model call", async function (this: ChatticusWorld) {
	const scenario = modelScenarioOf(this);
	scenario.scripted.reply("The answer after a slow model call.");
	const hold = scenario.scripted.slow();
	scenario.hold = hold;
	const started = startBotTurn(this, "Assistant");
	await hold.reached;
	this.clock.advanceSeconds(61);
	await eventuallyTrue(async () => {
		const lease = (await turnNow(this)).leaseExpiresAt;
		return lease !== null && lease.getTime() > this.clock.now().getTime();
	}, "the worker to renew its claim during the model call");
	hold.release();
	assert.equal(await started, "done");
});

Then("its turn claim is extended", async function (this: ChatticusWorld) {
	const lease = (await turnNow(this)).leaseExpiresAt;
	assert.ok(lease, "The turn has no lease");
	assert.ok(lease.getTime() > this.clock.now().getTime(), "The turn's lease has run out");
	const before = recoveryOf(this).leaseBefore;
	if (before !== null) assert.ok(lease.getTime() > before.getTime(), "The lease was not moved forward");
});

Then("its queue visibility is extended", async function (this: ChatticusWorld) {
	const tenantId = openChannel(this).tenantId;
	const turnId = currentTurnId(this);
	const since = this.runVisibilityExtensions.slice(recoveryOf(this).visibilityExtensionsBefore);
	assert.ok(since.some((extension) => extension.tenantId === tenantId && extension.turnId === turnId));
});

Given("a turn is blocked on the browser gate with its worker claim released", async function (this: ChatticusWorld) {
	const turnId = await postToBot(this, "Assistant", "open the household browser");
	const tenantId = openChannel(this).tenantId;
	const bot = this.botsByName?.get("Assistant");
	assert.ok(bot);
	const queued = this.queues.take(TURN_RUN_QUEUE, (body) => (body as { turnId: string }).turnId === turnId);
	assert.ok(queued, "No run job was queued for the turn");
	const deps = await executorDepsFor(this, modelScenarioOf(this));
	const claim = await claimTurnAttempt({ ...deps, workerLabel: "waiting-worker" }, { tenantId, turnId, botId: bot.botId });
	assert.ok(claim, "The worker could not claim the turn");
	await appendTurnEvent(this.turnDependencies(), tenantId, turnId, claim.attemptId, { kind: "turn.token", token: "Here is a draft." });
	await parkAttempt(deps, tenantId, turnId, claim.attemptId, "browser");
	const turn = await turnNow(this, turnId);
	assert.equal(turn.waitingFor, "browser");
	assert.equal(turn.attemptId, null);
	const state = recoveryOf(this);
	state.recoveryAttemptsBefore = turn.recoveryAttempts;
	state.logicalEnqueueIdsBefore = [...turn.logicalEnqueueIds];
});

Then("the turn remains waiting on the browser gate", async function (this: ChatticusWorld) {
	const turn = await turnNow(this);
	assert.equal(turn.status, "active");
	assert.equal(turn.waitingFor, "browser");
	assert.equal(turn.attemptId, null);
	assert.ok(queuedProbesFor(this, turn.turnId).length >= 1, "No probe is watching the waiting turn");
});

Then("recovery is not attempted again", async function (this: ChatticusWorld) {
	const turn = await turnNow(this);
	const state = recoveryOf(this);
	assert.equal(turn.recoveryAttempts, state.recoveryAttemptsBefore);
	assert.deepEqual([...turn.logicalEnqueueIds].sort(), [...state.logicalEnqueueIdsBefore].sort());
	assert.equal(queuedRunsFor(this, turn.turnId).length, 0);
});

When("the owner renews its claim just before it would run out", async function (this: ChatticusWorld) {
	const state = recoveryOf(this);
	state.ownerAttemptId = (await turnNow(this)).attemptId;
	assert.ok(state.ownerAttemptId, "No worker owns the turn");
	this.clock.advanceSeconds(59);
	const renewed = await renewAttempt(
		{ turns: this.turnDependencies(), runVisibility: runVisibilityOf(this) },
		openChannel(this).tenantId,
		currentTurnId(this),
		state.ownerAttemptId,
	);
	assert.equal(renewed, true);
});

When("the probe for that attempt comes due", async function (this: ChatticusWorld) {
	this.clock.advanceSeconds(2);
	await deliverDueProbes(this);
});

Then("the turn still belongs to that owner and is not recovered", async function (this: ChatticusWorld) {
	const turn = await turnNow(this);
	assert.equal(turn.status, "active");
	assert.equal(turn.attemptId, recoveryOf(this).ownerAttemptId);
	assert.equal(turn.recoveryAttempts, 0);
	assert.equal(queuedRunsFor(this, turn.turnId).length, 0);
	const lease = turn.leaseExpiresAt;
	assert.ok(lease);
	const secondsLeft = Math.ceil((lease.getTime() - this.clock.now().getTime()) / 1000);
	assert.ok(
		queuedProbeDelaysFor(this, turn.turnId).includes(secondsLeft),
		`No probe is set to look at the turn again when its lease runs out in ${secondsLeft} seconds`,
	);
});

When("the turn has waited for {int} minutes", async function (this: ChatticusWorld, minutes: number) {
	for (let minute = 0; minute < minutes; minute += 1) {
		this.clock.advanceSeconds(60);
		await deliverDueProbes(this);
	}
});

Then("the turn waits no longer and no recovery is queued", async function (this: ChatticusWorld) {
	const turn = await turnNow(this);
	assert.equal(turn.status, "failed");
	assert.equal(turn.terminalReason, COMPUTER_UNAVAILABLE_REASON);
	assert.equal(queuedRunsFor(this, turn.turnId).length, 0);
	assert.equal(queuedProbesFor(this, turn.turnId).length, 0);
});

Given(
	"a worker's process ends after the model answered but before it committed the answer",
	async function (this: ChatticusWorld) {
		const turnId = await postToBot(this, "Assistant", "hello");
		this.faultPlan.arm("completion_append", "before");
		await assert.rejects(runQueuedJobs(this), SimulatedCrash);
		this.faultPlan.clear();
		this.queues.take(TURN_RUN_QUEUE, (body) => (body as { turnId: string }).turnId === turnId);
		assert.equal(this.faultPlan.crashedAt?.boundary, "completion_append");
		assert.equal((await turnNow(this, turnId)).status, "active");
	},
);

Then("the turn is finished from the answer the conversation already holds", async function (this: ChatticusWorld) {
	const turnId = currentTurnId(this);
	const turn = await turnNow(this, turnId);
	assert.ok(turn.logicalEnqueueIds.includes(finalizeEnqueueId(turnId)), "The probe did not queue a run to finish the turn");
	assert.equal(queuedRunsFor(this, turnId).length, 1);
	assert.equal((await runQueuedJobs(this)).join(","), "done");
	assert.equal((await turnNow(this, turnId)).status, "completed");
	assert.equal(modelScenarioOf(this).scripted.callCount, 1);
});

When("the function has {int} seconds of time left", function (this: ChatticusWorld, seconds: number) {
	modelScenarioOf(this).functionMillisecondsLeft = seconds * 1000;
});

Then("the turn is handed on to a later owner", async function (this: ChatticusWorld) {
	const scenario = modelScenarioOf(this);
	const turnId = currentTurnId(this);
	const tenantId = openChannel(this).tenantId;
	await eventuallyTrue(
		async () => (await readTurnEvents(this, tenantId, turnId)).some((event) => event.kind === "attempt.relinquished"),
		"the owner to hand the turn on",
	);
	const turn = await turnNow(this, turnId);
	assert.equal(turn.status, "active");
	assert.equal(turn.attemptId, null);
	assert.equal(turn.leaseExpiresAt, null);
	const events = await readTurnEvents(this, openChannel(this).tenantId, turnId);
	assert.equal(events.filter((event) => event.kind === "attempt.relinquished").length, 1);
	assert.equal(queuedRunsFor(this, turnId).length, 1);
	assert.ok(queuedProbesFor(this, turnId).length >= 1);
	scenario.functionMillisecondsLeft = undefined;
});

Then("the first owner ended by handing the turn on", function (this: ChatticusWorld) {
	assert.equal(modelScenarioOf(this).lastOutcome, "yielded");
});

When("the former owner tries to renew its claim", async function (this: ChatticusWorld) {
	const state = recoveryOf(this);
	assert.ok(state.ownerAttemptId, "No worker owned the turn");
	const before = this.runVisibilityExtensions.length;
	const renewed = await renewAttempt(
		{ turns: this.turnDependencies(), runVisibility: runVisibilityOf(this) },
		openChannel(this).tenantId,
		currentTurnId(this),
		state.ownerAttemptId,
	);
	state.visibilityExtensionsBefore = before;
	assert.equal(renewed, false);
});

Then("its claim and queue visibility are not extended", async function (this: ChatticusWorld) {
	assert.equal(this.runVisibilityExtensions.length, recoveryOf(this).visibilityExtensionsBefore);
	const turn = await turnNow(this);
	assert.equal(turn.attemptId, null);
	assert.equal(turn.leaseExpiresAt, null);
});
