import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { ensureComputer } from "../../src/domain/computers.ts";
import type { ComputerPolicy } from "../../src/domain/workers.ts";
import { recordResponse } from "../api.ts";
import {
	computerScenarioOf,
	diskOf,
	hostNamed,
	queuedStartJobs,
	registerHost,
	scenarioTenantId,
	turnPayloadNow,
	workTurn,
} from "../computer-scenario.ts";
import { memberPost } from "../org-user-client.ts";
import { deliverDueProbes, queuedRunsFor } from "../turn-recovery.ts";
import { activeTurnOf } from "../turn-grant-support.ts";
import type { ChatticusWorld } from "../world.ts";

Given("host worker {string} serves the household computer", async function (this: ChatticusWorld, workerId: string) {
	await registerHost(this, scenarioTenantId(this), workerId, "local");
});

Given("the household computer policy is {string}", async function (this: ChatticusWorld, policy: string) {
	const tenantId = scenarioTenantId(this);
	const computer = await ensureComputer(tenantId, { store: this.messagingStore(), ids: this.ids });
	await this.messagingStore().putComputer({ ...computer, policy: policy as ComputerPolicy });
});

Given(
	"the computer holds the file {string} containing {string}",
	function (this: ChatticusWorld, path: string, content: string) {
		diskOf(this, scenarioTenantId(this)).set(path, content);
	},
);

When("host worker {string} runs the next computer action", async function (this: ChatticusWorld, workerId: string) {
	const action = await hostNamed(this, workerId).runNextAction();
	assert.ok(action, "The host found no computer action to run.");
});

When(
	"host worker {string} runs the next computer action but is lost before it posts the result",
	async function (this: ChatticusWorld, workerId: string) {
		const host = hostNamed(this, workerId);
		const action = await host.claim();
		assert.ok(action, "The host found no computer action to run.");
		host.execute(action);
	},
);

When("host worker {string} posts that result again", async function (this: ChatticusWorld, workerId: string) {
	const host = hostNamed(this, workerId);
	assert.ok(host.lastPost, "The host has posted no result.");
	const response = await host.postResult(host.lastPost.actionId, host.lastPost.result);
	assert.equal(response.status, 200, response.text);
});

When(
	"user {string} of tenant {string} tries to resume that waiting turn",
	async function (this: ChatticusWorld, _userId: string, tenantId: string) {
		const { turnId } = activeTurnOf(this);
		this.lastHttpResponse = await memberPost(this, `/orgs/${tenantId}/turns/${turnId}/resume`, {});
	},
);

When(
	"user {string} of tenant {string} resumes that waiting turn",
	async function (this: ChatticusWorld, _userId: string, tenantId: string) {
		const { turnId } = activeTurnOf(this);
		const response = await recordResponse(await memberPost(this, `/orgs/${tenantId}/turns/${turnId}/resume`, {}));
		assert.equal(response.status, 200, response.text);
	},
);

When("the turn probe runs", async function (this: ChatticusWorld) {
	await deliverDueProbes(this);
});

When("bot {string} works its turn until it waits for the computer", async function (this: ChatticusWorld, botName: string) {
	assert.equal(await workTurn(this, botName), "parked");
});

When("bot {string} works its turn after the computer answered", async function (this: ChatticusWorld, botName: string) {
	assert.equal(await workTurn(this, botName), "done");
});

Then("resume is refused because the computer is not ready", async function (this: ChatticusWorld) {
	assert.ok(this.lastHttpResponse, "No resume was attempted.");
	const response = await recordResponse(this.lastHttpResponse);
	assert.equal(response.status, 409, response.text);
	assert.ok(String(response.json.detail).includes("still stopped"), response.text);
});

Then("a computer start job is queued for the turn", function (this: ChatticusWorld) {
	const { turnId } = activeTurnOf(this);
	const jobs = queuedStartJobs(this).filter((job) => job.turnId === turnId);
	assert.equal(jobs.length, 1, `Start jobs queued for the turn: ${JSON.stringify(jobs)}`);
	assert.ok(jobs[0]!.requiredCapabilities.includes("computer"));
});

Then("a computer continuation job is queued for the turn", function (this: ChatticusWorld) {
	const { turnId } = activeTurnOf(this);
	const jobs = queuedStartJobs(this).filter((job) => job.turnId === turnId);
	assert.equal(jobs.length, 1, `Start jobs queued for the turn: ${JSON.stringify(jobs)}`);
	assert.ok(jobs[0]!.requiredCapabilities.includes("computer"));
});

Then(
	"a computer start job is queued for the turn with policy {string}",
	function (this: ChatticusWorld, policy: string) {
		const { turnId } = activeTurnOf(this);
		const jobs = queuedStartJobs(this).filter((job) => job.turnId === turnId);
		assert.equal(jobs.length, 1, `Start jobs queued for the turn: ${JSON.stringify(jobs)}`);
		assert.equal(jobs[0]!.computerPolicy, policy);
	},
);

Then("no computer start job is queued", function (this: ChatticusWorld) {
	assert.deepEqual(queuedStartJobs(this), []);
});

Then("another computer start job is queued for the turn", function (this: ChatticusWorld) {
	const { turnId } = activeTurnOf(this);
	assert.ok(queuedStartJobs(this).filter((job) => job.turnId === turnId).length >= 2, "No second start job was queued");
});

Then("exactly one run job is queued for the turn", function (this: ChatticusWorld) {
	const { turnId } = activeTurnOf(this);
	assert.equal(queuedRunsFor(this, turnId).length, 1);
});

Then("the host executed {string} exactly once", function (this: ChatticusWorld, toolName: string) {
	const runs = [...computerScenarioOf(this).hosts.values()].flatMap((host) =>
		host.executions.filter((execution) => execution.toolName === toolName),
	);
	assert.equal(runs.length, 1, `The host ran ${toolName} ${runs.length} times`);
});

Then("the turn is waiting on the {word} gate", async function (this: ChatticusWorld, gate: string) {
	const turn = await turnPayloadNow(this);
	assert.equal(turn.status, "active");
	assert.equal(turn.waiting_for, gate);
});

Then("the turn is waiting on the workspace capability", async function (this: ChatticusWorld) {
	const turn = await turnPayloadNow(this);
	assert.equal(turn.status, "active");
	assert.equal(turn.waiting_for, "workspace");
});
