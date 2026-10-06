import assert from "node:assert/strict";
import { DynamoMessagingStore } from "../../src/store/dynamo-messaging-store.ts";
import { Given, Then, When } from "@cucumber/cucumber";
import { ComputerWorkerRequiresComputerCapability } from "../../src/domain/computer-start.ts";
import { requestComputerHostStart } from "../../src/domain/computers.ts";
import { actionStoreOf } from "../computer-support.ts";
import {
	bootingHostStartDriver,
	computerScenarioOf,
	deliverStartJob,
	diskOf,
	journalNow,
	queuedStartJobs,
	registerHost,
	startStoryTurn,
	STORY_BOT,
	STORY_TENANT,
	STORY_USER,
	workTurn,
} from "../computer-scenario.ts";
import { FakeHostStartDriver } from "../fakes/fake-host-start-driver.ts";
import { modelScenarioOf } from "../executor-harness.ts";
import { activeTurnOf } from "../turn-grant-support.ts";
import { runQueuedJobs } from "../turn-recovery.ts";
import type { ChatticusWorld } from "../world.ts";

export const CONTINUATION_PATH = "/workspace/inbox.txt";
export const CONTINUATION_RESULT = "opened";

function startJobOf(world: ChatticusWorld) {
	const job = computerScenarioOf(world).startJob;
	assert.ok(job, "The scenario has no queued continuation job.");
	return job;
}

function driverOf(world: ChatticusWorld): FakeHostStartDriver {
	const state = computerScenarioOf(world);
	state.driver ??= new FakeHostStartDriver();
	return state.driver;
}

Given("a fenced computer handoff with a queued continuation job", async function (this: ChatticusWorld) {
	diskOf(this, STORY_TENANT).set(CONTINUATION_PATH, CONTINUATION_RESULT);
	modelScenarioOf(this).scripted.toolCall("read_workspace", { path: CONTINUATION_PATH }, "Opening the inbox.").reply("Inbox opened.");
	await startStoryTurn(this, "open the inbox");
	assert.equal(await workTurn(this, STORY_BOT), "parked");
	const state = computerScenarioOf(this);
	const jobs = queuedStartJobs(this);
	assert.equal(jobs.length, 1, "The parked turn queued no single continuation job.");
	state.startJob = jobs[0]!;
	const { tenantId, turnId } = activeTurnOf(this);
	const [action] = await actionStoreOf(this).listForTurn(tenantId, turnId);
	state.pendingActionId = action!.actionId;
});

Given("a recording host start driver", function (this: ChatticusWorld) {
	computerScenarioOf(this).driver = new FakeHostStartDriver();
});

Given("the pending computer action ran before its lease expired", async function (this: ChatticusWorld) {
	const host = await registerHost(this, STORY_TENANT, "first-host", "local");
	const action = await host.claim();
	assert.ok(action, "The first host found no action to run.");
	host.execute(action);
	this.clock.advanceSeconds(61);
});

When("a computer-capable worker pulls that continuation job", async function (this: ChatticusWorld) {
	const state = computerScenarioOf(this);
	const outcome = await deliverStartJob(this, startJobOf(this), bootingHostStartDriver(this));
	assert.equal(state.startError, null, state.startError?.message);
	assert.ok(outcome, "The start job ended with no outcome.");
	assert.equal((await runQueuedJobs(this)).at(-1), "done");
});

When("a computer-capable worker pulls that continuation job after the lease dies", async function (this: ChatticusWorld) {
	const state = computerScenarioOf(this);
	const outcome = await deliverStartJob(this, startJobOf(this), bootingHostStartDriver(this));
	assert.equal(state.startError, null, state.startError?.message);
	assert.ok(outcome, "The start job ended with no outcome.");
	assert.equal((await runQueuedJobs(this)).at(-1), "done");
});

When("a computer-capable worker is given a cpu-only job for that turn", async function (this: ChatticusWorld) {
	const cpuJob = { ...startJobOf(this), jobId: this.ids.next(), requiredCapabilities: ["cpu"] };
	await deliverStartJob(this, cpuJob, bootingHostStartDriver(this));
});

When(
	"a computer-capable pull worker without a host executor pulls that continuation job",
	async function (this: ChatticusWorld) {
		await deliverStartJob(this, startJobOf(this), driverOf(this));
		assert.equal(computerScenarioOf(this).startError, null, computerScenarioOf(this).startError?.message);
	},
);

When(
	"two computer-capable pull workers without a host executor pull that continuation concurrently",
	async function (this: ChatticusWorld) {
		const driver = driverOf(this);
		await Promise.all([deliverStartJob(this, startJobOf(this), driver), deliverStartJob(this, startJobOf(this), driver)]);
		assert.equal(computerScenarioOf(this).startError, null, computerScenarioOf(this).startError?.message);
	},
);

When("the host start lease expires", function (this: ChatticusWorld) {
	this.clock.advanceSeconds(61);
});

When(
	"a second process sharing the store records a host start for tenant {string} user {string}",
	async function (this: ChatticusWorld, tenantId: string, userId: string) {
		const second = new DynamoMessagingStore(this.messagingTable.client, this.messagingTable.tableName);
		await requestComputerHostStart(
			{ store: second, clock: this.clock, ids: this.ids, spend: { store: second, rollups: this.store, environment: this.budgetEnvironment, clock: this.clock } },
			tenantId,
			userId,
		);
	},
);

When("a second process sharing the store nacks that continuation without a host", async function (this: ChatticusWorld) {
	const second = new DynamoMessagingStore(this.messagingTable.client, this.messagingTable.tableName);
	await deliverStartJob(this, startJobOf(this), driverOf(this), second);
	assert.equal(computerScenarioOf(this).startError, null, computerScenarioOf(this).startError?.message);
});

Then("the turn journal records tool.result for the pending action id", async function (this: ChatticusWorld) {
	const state = computerScenarioOf(this);
	const { tenantId } = activeTurnOf(this);
	const action = await actionStoreOf(this).get(tenantId, state.pendingActionId!);
	const results = (await journalNow(this)).filter((event) => event.kind === "tool.result" && event.action_id === action?.callId);
	assert.equal(results.length, 1);
	assert.equal(results[0]!.body, CONTINUATION_RESULT);
});

Then("the pull worker leaves no unresolved tool calls", async function (this: ChatticusWorld) {
	const events = await journalNow(this);
	const resolved = new Set(events.filter((event) => event.kind === "tool.result").map((event) => event.action_id));
	for (const call of events.filter((event) => event.kind === "tool.call")) {
		assert.ok(resolved.has(call.action_id), `Call ${call.action_id} has no result`);
	}
	const { tenantId, turnId } = activeTurnOf(this);
	assert.ok((await actionStoreOf(this).listForTurn(tenantId, turnId)).every((action) => action.status === "done"));
});

Then("the computer continuation job is removed from the queue", function (this: ChatticusWorld) {
	const job = startJobOf(this);
	assert.deepEqual(queuedStartJobs(this).filter((queued) => queued.jobId === job.jobId), []);
});

Then("the computer continuation job remains queued", function (this: ChatticusWorld) {
	const job = startJobOf(this);
	assert.equal(queuedStartJobs(this).filter((queued) => queued.jobId === job.jobId).length, 1);
	assert.ok(job.requiredCapabilities.includes("computer"));
});

Then("the computer-capable worker refuses the cpu job", function (this: ChatticusWorld) {
	assert.ok(computerScenarioOf(this).startError instanceof ComputerWorkerRequiresComputerCapability);
});

Then("the host start driver was invoked once", function (this: ChatticusWorld) {
	assert.equal(driverOf(this).invocations.length, 1);
});

Then("the host start driver was still invoked only once", function (this: ChatticusWorld) {
	assert.equal(driverOf(this).invocations.length, 1);
});

Then("the host start driver was invoked twice", function (this: ChatticusWorld) {
	assert.equal(driverOf(this).invocations.length, 2);
});

Then("the host start claim carries user {string}", function (this: ChatticusWorld, userId: string) {
	const [invocation] = driverOf(this).invocations;
	assert.equal(invocation?.claim.userId, userId);
	assert.equal(invocation?.claim.userId, STORY_USER);
});

Then("the computer was reclaimed by the pull worker", async function (this: ChatticusWorld) {
	const state = computerScenarioOf(this);
	const { tenantId } = activeTurnOf(this);
	const action = await actionStoreOf(this).get(tenantId, state.pendingActionId!);
	assert.equal(action?.status, "done");
	assert.notEqual(action?.claimedBy, "first-host");
	assert.ok(action?.claimedBy, "No host reclaimed the action");
});

Then("the tool result is committed once", async function (this: ChatticusWorld) {
	const results = (await journalNow(this)).filter((event) => event.kind === "tool.result");
	assert.equal(results.length, 1);
	assert.equal(results[0]!.body, CONTINUATION_RESULT);
});
