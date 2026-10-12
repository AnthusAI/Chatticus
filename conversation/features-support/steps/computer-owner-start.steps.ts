import assert from "node:assert/strict";
import { Given, Then, When, type DataTable } from "@cucumber/cucumber";
import { OWNER_BOOTSTRAP_TOKEN_LIFETIME_SECONDS } from "@chatticus/host-protocol/supervisor";
import { ensureComputer } from "../../src/domain/computers.ts";
import { getTurn } from "../../src/domain/turns.ts";
import { verifyComputerOwnerToken, verifyOwnerBootstrapToken, verifySessionToken } from "../../src/gateway/session-token.ts";
import { deliverStartJob, computerScenarioOf, queuedStartJobs, startStoryTurn, STORY_BOT, STORY_TENANT, workTurn } from "../computer-scenario.ts";
import { computerOwnerScenarioOf } from "../computer-owner.ts";
import { modelScenarioOf } from "../executor-harness.ts";
import { ensureTestOrganization } from "../org-user-client.ts";
import { SCENARIO_GATEWAY_SIGNING_KEY } from "../model-gateway-support.ts";
import {
	composeStarter,
	containerEnvironmentOf,
	organizationHomedIn,
	OWNER_START_DEPLOYMENT_ACCOUNT,
	OWNER_START_INVOKE_KEY,
	ownerRuntimeSettings,
	ownerStartOf,
	runTaskOf,
	withCapturedLogs,
} from "../owner-start-support.ts";
import type { ChatticusWorld } from "../world.ts";

const BOOTSTRAP_VARIABLE = "CHATTICUS_OWNER_BOOTSTRAP_TOKEN";

function startJobOf(world: ChatticusWorld) {
	const job = computerScenarioOf(world).startJob;
	assert.ok(job, "No start job is queued in this scenario.");
	return job;
}

const environmentValue = (world: ChatticusWorld, name: string, index = 0): string => {
	const value = containerEnvironmentOf(world, index).get(name);
	assert.ok(value !== undefined && value !== "", `The container environment has no ${name}.`);
	return value;
};

Given("a turn parked on the workspace with its start job queued", async function (this: ChatticusWorld) {
	computerOwnerScenarioOf(this);
	modelScenarioOf(this).scripted.toolCall("write_workspace", { path: "/workspace/notes.md", content: "draft-one" }, "Working on it.").reply("Notes saved.");
	await startStoryTurn(this, "save the notes");
	assert.equal(await workTurn(this, STORY_BOT), "parked");
	const jobs = queuedStartJobs(this);
	assert.equal(jobs.length, 1, "The parked turn queued no single start job.");
	computerScenarioOf(this).startJob = jobs[0]!;
});

Given("the organization is homed in the deployment account", async function (this: ChatticusWorld) {
	await ensureTestOrganization(this, STORY_TENANT);
	const store = this.messagingStore();
	await store.putOrganization(organizationHomedIn(await store.getOrganization(STORY_TENANT), OWNER_START_DEPLOYMENT_ACCOUNT));
});

Given("the organization is homed in the account {string} with no cross-account role", async function (this: ChatticusWorld, account: string) {
	const store = this.messagingStore();
	await store.putOrganization(organizationHomedIn(await store.getOrganization(STORY_TENANT), account));
});

Given(
	"the organization is homed in the account {string} with a ChatticusComputers stack and a cross-account role",
	async function (this: ChatticusWorld, account: string) {
		const store = this.messagingStore();
		const homed = organizationHomedIn(await store.getOrganization(STORY_TENANT), account);
		await store.putOrganization({
			...homed,
			awsCrossAccountRole: `arn:aws:iam::${account}:role/ChatticusOrganizationComputerRole`,
			awsExternalId: "scenario-external-id",
			awsSetupPath: "customer-owned",
		});
	},
);

Given("the organization has no AWS home", async function (this: ChatticusWorld) {
	const store = this.messagingStore();
	const organization = organizationHomedIn(await store.getOrganization(STORY_TENANT), OWNER_START_DEPLOYMENT_ACCOUNT);
	await store.putOrganization({ ...organization, awsAccountId: null, awsSetupPath: null });
});

Given("the starter has the owner settings", function (this: ChatticusWorld) {
	Object.assign(ownerStartOf(this).environment, ownerRuntimeSettings());
});

When("the starter handles the start job", async function (this: ChatticusWorld) {
	const composed = await composeStarter(this);
	assert.ok(composed, `The starter was not composed: ${ownerStartOf(this).composeError?.message}`);
	await withCapturedLogs(this, () => deliverStartJob(this, startJobOf(this), composed.driver));
});

When("the starter handles the start job again", async function (this: ChatticusWorld) {
	const composed = await composeStarter(this);
	assert.ok(composed);
	await withCapturedLogs(this, () => deliverStartJob(this, startJobOf(this), composed.driver));
});

When("the host start lease expires and the starter handles the start job", async function (this: ChatticusWorld) {
	this.clock.advanceSeconds(61);
	const composed = await composeStarter(this);
	assert.ok(composed);
	await withCapturedLogs(this, () => deliverStartJob(this, startJobOf(this), composed.driver));
});

When("the starter is composed", async function (this: ChatticusWorld) {
	await composeStarter(this);
});

Then("the starter was refused at composition mentioning {string}", function (this: ChatticusWorld, text: string) {
	const error = ownerStartOf(this).composeError;
	assert.ok(error, "The starter was composed.");
	assert.ok(error.message.includes(text), error.message);
	assert.equal(ownerStartOf(this).ecs.runTaskCalls.length, 0);
});

Then("the start ended {string}", function (this: ChatticusWorld, kind: string) {
	const state = computerScenarioOf(this);
	assert.equal(state.startError, null, state.startError?.message);
	assert.equal(state.startOutcome?.kind, kind);
});

Then("the start was refused mentioning {string}", function (this: ChatticusWorld, text: string) {
	const error = computerScenarioOf(this).startError;
	assert.ok(error, "The start was not refused.");
	assert.ok(error.message.includes(text), error.message);
});

Then("the starter ran exactly {int} ECS task(s)", function (this: ChatticusWorld, count: number) {
	assert.equal(ownerStartOf(this).ecs.runTaskCalls.length, count);
});

Then("the task ran task definition {string} in cluster {string}", function (this: ChatticusWorld, definition: string, cluster: string) {
	assert.equal(runTaskOf(this).taskDefinition, definition);
	assert.equal(runTaskOf(this).cluster, cluster);
});

Then("the task overrode container {string} with the command {string}", function (this: ChatticusWorld, container: string, command: string) {
	const override = runTaskOf(this).overrides?.containerOverrides;
	assert.equal(override?.length, 1);
	assert.equal(override[0]!.name, container);
	assert.equal(override[0]!.command.join(" "), command);
});

Then("the container environment holds:", function (this: ChatticusWorld, table: DataTable) {
	for (const [name, value] of table.raw()) {
		assert.equal(containerEnvironmentOf(this).get(name!), value, name);
	}
});

Then("the container environment holds the table of the messaging store", function (this: ChatticusWorld) {
	assert.equal(environmentValue(this, "CHATTICUS_MESSAGING_TABLE"), this.messagingTable.tableName);
});

Then("the container environment names the organization, the computer and the member of the start job", async function (this: ChatticusWorld) {
	const job = startJobOf(this);
	const computer = await ensureComputer(job.tenantId, { store: this.messagingStore(), ids: this.ids });
	assert.equal(environmentValue(this, "CHATTICUS_TENANT_ID"), job.tenantId);
	assert.equal(environmentValue(this, "CHATTICUS_COMPUTER_ID"), computer.computerId);
	assert.equal(environmentValue(this, "CHATTICUS_USER_ID"), job.userId);
});

Then("the container environment holds no invoke key and no copy of the invoke key's value", function (this: ChatticusWorld) {
	const environment = containerEnvironmentOf(this);
	assert.equal(environment.has("CHATTICUS_INVOKE_KEY"), false);
	for (const [name, value] of environment) {
		assert.ok(!value.includes(OWNER_START_INVOKE_KEY), `${name} carries the invoke key`);
	}
});

Then("the starter assumed no role", function (this: ChatticusWorld) {
	assert.equal(ownerStartOf(this).crossAccount.calls.length, 0);
	assert.equal(ownerStartOf(this).ecs.runTaskCalls.length, 1);
});

Then("the container environment names no turn, no bot, no gateway token, no host token and no AWS credential", function (this: ChatticusWorld) {
	const names = new Set(containerEnvironmentOf(this).keys());
	for (const forbidden of [
		"CHATTICUS_TAKEOVER_TURN_ID",
		"CHATTICUS_TAKEOVER_BOT_ID",
		"CHATTICUS_MODEL_GATEWAY_TOKEN",
		"CHATTICUS_OWNER_HOST_TOKEN",
		"AWS_ACCESS_KEY_ID",
		"AWS_SECRET_ACCESS_KEY",
		"AWS_SESSION_TOKEN",
	]) {
		assert.equal(names.has(forbidden), false, `${forbidden} is in the container environment`);
	}
});

Then("the container environment holds exactly one secret: a bootstrap token valid for {int} seconds", function (this: ChatticusWorld, seconds: number) {
	assert.equal(seconds, OWNER_BOOTSTRAP_TOKEN_LIFETIME_SECONDS);
	const secretNames = [...containerEnvironmentOf(this).keys()].filter((name) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name));
	assert.deepEqual(secretNames, [BOOTSTRAP_VARIABLE]);
	const verification = verifyOwnerBootstrapToken(SCENARIO_GATEWAY_SIGNING_KEY, environmentValue(this, BOOTSTRAP_VARIABLE), this.clock.now());
	assert.ok(verification.valid, JSON.stringify(verification));
	assert.equal(verification.claims.expiresAtSeconds - verification.claims.issuedAtSeconds, seconds);
	assert.equal(verification.claims.expiresAtSeconds, Math.floor(this.clock.now().getTime() / 1000) + seconds);
});

Then("the bootstrap token names the organization, the computer, the new owner id and the claimed generation", async function (this: ChatticusWorld) {
	const job = startJobOf(this);
	const computer = await ensureComputer(job.tenantId, { store: this.messagingStore(), ids: this.ids });
	const verification = verifyOwnerBootstrapToken(SCENARIO_GATEWAY_SIGNING_KEY, environmentValue(this, BOOTSTRAP_VARIABLE), this.clock.now());
	assert.ok(verification.valid, JSON.stringify(verification));
	const issuedAtSeconds = Math.floor(this.clock.now().getTime() / 1000);
	assert.deepEqual(verification.claims, {
		audience: "owner-bootstrap",
		tenantId: job.tenantId,
		computerId: computer.computerId,
		ownerId: environmentValue(this, "CHATTICUS_OWNER_ID"),
		startGeneration: computer.hostStartGeneration,
		issuedAtSeconds,
		expiresAtSeconds: issuedAtSeconds + OWNER_BOOTSTRAP_TOKEN_LIFETIME_SECONDS,
	});
	assert.equal(computer.hostStartGeneration, 1);
});

Then("the bootstrap token is not valid as a supervisor token or as a gateway token", function (this: ChatticusWorld) {
	const token = environmentValue(this, BOOTSTRAP_VARIABLE);
	assert.deepEqual(verifyComputerOwnerToken(SCENARIO_GATEWAY_SIGNING_KEY, token, this.clock.now()), { valid: false, reason: "audience" });
	assert.deepEqual(verifySessionToken(SCENARIO_GATEWAY_SIGNING_KEY, token, this.clock.now(), "model-gateway"), { valid: false, reason: "audience" });
});

Then("the starter registered the owner as a worker of the household computer", async function (this: ChatticusWorld) {
	const ownerId = environmentValue(this, "CHATTICUS_OWNER_ID");
	const worker = await this.messagingStore().getWorker(STORY_TENANT, ownerId);
	assert.ok(worker, "The starter registered no worker for the owner.");
	assert.deepEqual([...worker.capabilities].sort(), ["computer", "cpu"]);
	assert.equal(worker.costClass, "local");
	assert.equal(worker.computerId, (await ensureComputer(STORY_TENANT, { store: this.messagingStore(), ids: this.ids })).computerId);
});

Then("the organization has no worker registered by the starter", async function (this: ChatticusWorld) {
	const workers = await this.messagingStore().listWorkers(STORY_TENANT);
	assert.deepEqual(workers.filter((worker) => worker.workerId.startsWith("owner-")), []);
});

Then("the container environment holds a fresh owner id", function (this: ChatticusWorld) {
	assert.match(environmentValue(this, "CHATTICUS_OWNER_ID"), /^owner-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

Then("the second task has a different owner id and a different bootstrap token from the first", function (this: ChatticusWorld) {
	assert.equal(ownerStartOf(this).ecs.runTaskCalls.length, 2);
	assert.notEqual(environmentValue(this, "CHATTICUS_OWNER_ID", 0), environmentValue(this, "CHATTICUS_OWNER_ID", 1));
	assert.notEqual(environmentValue(this, BOOTSTRAP_VARIABLE, 0), environmentValue(this, BOOTSTRAP_VARIABLE, 1));
});

Then("the cross-account role was assumed exactly {int} time(s)", function (this: ChatticusWorld, count: number) {
	assert.equal(ownerStartOf(this).crossAccount.calls.length, count);
});

Then("the customer account ran exactly {int} ECS task(s)", function (this: ChatticusWorld, count: number) {
	assert.equal(ownerStartOf(this).customerEcs.runTaskCalls.length, count);
});

Then("the customer task overrode container {string} with the command {string}", function (this: ChatticusWorld, container: string, command: string) {
	const override = ownerStartOf(this).customerEcs.runTaskCalls[0]?.overrides?.containerOverrides;
	assert.equal(override?.length, 1);
	assert.equal(override[0]!.name, container);
	assert.equal(override[0]!.command.join(" "), command);
});

Then("no cross-account role was assumed", function (this: ChatticusWorld) {
	assert.equal(ownerStartOf(this).crossAccount.calls.length, 0);
});

Given("the computer of the organization has the identifier {string}", async function (this: ChatticusWorld, computerId: string) {
	const store = this.messagingStore();
	const computer = await ensureComputer(STORY_TENANT, { store, ids: this.ids });
	await store.putComputer({ ...computer, computerId });
});

Then("the starter logged none of the bootstrap token, the invoke key and the signing key", function (this: ChatticusWorld) {
	const output = ownerStartOf(this).logs.join("\n");
	assert.ok(output.includes("owner_task_started"), "The starter logged nothing about the start");
	for (const secret of [environmentValue(this, BOOTSTRAP_VARIABLE), OWNER_START_INVOKE_KEY, SCENARIO_GATEWAY_SIGNING_KEY]) {
		assert.ok(!output.includes(secret), "A secret reached a log line");
	}
});

Then("the parked turn failed telling the person the organization has no computer set up yet", async function (this: ChatticusWorld) {
	const job = startJobOf(this);
	const turn = await getTurn(this.turnDependencies(), job.tenantId, job.turnId);
	assert.equal(turn.status, "failed");
	assert.ok(turn.terminalReason?.includes("no computer set up yet"), String(turn.terminalReason));
	assert.ok(turn.terminalReason?.includes("Ask your Chatticus operator"), String(turn.terminalReason));
});

Then("the start job is not retried", function (this: ChatticusWorld) {
	assert.equal(computerScenarioOf(this).startError, null, computerScenarioOf(this).startError?.message);
	assert.equal(queuedStartJobs(this).length, 0);
});

Then("no start job is left for the dead-letter queue", function (this: ChatticusWorld) {
	assert.equal(queuedStartJobs(this).length, 0, "A start job is still on the queue, so it would be redelivered until it dead-letters.");
});

Then("the starter made exactly {int} start attempt(s)", async function (this: ChatticusWorld, count: number) {
	const computer = await this.messagingStore().getComputer(STORY_TENANT);
	assert.equal(computer?.hostStartGeneration, count);
});

Then("the starter logged one {string} line with the tenant, the turn and the reason class {string}", function (this: ChatticusWorld, event: string, reasonClass: string) {
	const job = startJobOf(this);
	const lines = ownerStartOf(this).logs.filter((line) => line.includes(event));
	assert.equal(lines.length, 1, lines.join("\n"));
	assert.ok(lines[0]!.includes(job.tenantId) && lines[0]!.includes(job.turnId) && lines[0]!.includes(reasonClass), lines[0]);
});

Then("the starter logged no {string} line", function (this: ChatticusWorld, event: string) {
	assert.equal(ownerStartOf(this).logs.filter((line) => line.includes(event)).length, 0);
});

Then("the start failed and the parked turn is still waiting", async function (this: ChatticusWorld) {
	assert.ok(computerScenarioOf(this).startError, "The start did not fail.");
	const job = startJobOf(this);
	const turn = await getTurn(this.turnDependencies(), job.tenantId, job.turnId);
	assert.equal(turn.status, "active");
	assert.notEqual(turn.waitingFor, null);
});

Then("the start job is queued again", function (this: ChatticusWorld) {
	assert.equal(queuedStartJobs(this).length, 1);
});
