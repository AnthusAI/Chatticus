import assert from "node:assert/strict";
import { Given, Then, When, type DataTable } from "@cucumber/cucumber";
import { SESSION_POLICY_MAXIMUM_CHARACTERS, buildOwnerSessionPolicy } from "../../src/gateway/session-policy.ts";
import { verifySessionToken } from "../../src/gateway/session-token.ts";
import { ensureComputer } from "../../src/domain/computers.ts";
import { getTurn } from "../../src/domain/turns.ts";
import { deliverStartJob, computerScenarioOf, queuedStartJobs, startStoryTurn, STORY_BOT, STORY_TENANT, workTurn } from "../computer-scenario.ts";
import { computerOwnerScenarioOf, startComputerOwner } from "../computer-owner.ts";
import { httpBaseUrl } from "../front-door.ts";
import { modelScenarioOf } from "../executor-harness.ts";
import { FAKE_SCOPED_CREDENTIALS } from "../fakes/fake-ecs.ts";
import { gatewayScenarioOf, SCENARIO_GATEWAY_SIGNING_KEY } from "../model-gateway-support.ts";
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
import { activeTurnOf } from "../turn-grant-support.ts";
import type { ChatticusWorld } from "../world.ts";

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

Given("the starter has the owner settings", function (this: ChatticusWorld) {
	Object.assign(ownerStartOf(this).environment, ownerRuntimeSettings());
});

Given("the starter has the owner settings without the setting {string}", function (this: ChatticusWorld, name: string) {
	const scenario = ownerStartOf(this);
	Object.assign(scenario.environment, ownerRuntimeSettings());
	delete scenario.environment[name];
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

Then("the container environment names the turn, the bot and the member of the start job", function (this: ChatticusWorld) {
	const job = startJobOf(this);
	assert.equal(environmentValue(this, "CHATTICUS_TAKEOVER_TURN_ID"), job.turnId);
	assert.equal(environmentValue(this, "CHATTICUS_TAKEOVER_BOT_ID"), job.botId);
	assert.equal(environmentValue(this, "CHATTICUS_TENANT_ID"), job.tenantId);
	assert.equal(environmentValue(this, "CHATTICUS_USER_ID"), job.userId);
});

Then("the container environment holds the invoke key read from its secret", function (this: ChatticusWorld) {
	assert.equal(environmentValue(this, "CHATTICUS_INVOKE_KEY"), OWNER_START_INVOKE_KEY);
});

Then("the container environment holds a fresh owner id", function (this: ChatticusWorld) {
	assert.match(environmentValue(this, "CHATTICUS_OWNER_ID"), /^owner-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

Then("the second task has a different owner id and a different gateway token from the first", function (this: ChatticusWorld) {
	assert.equal(ownerStartOf(this).ecs.runTaskCalls.length, 2);
	assert.notEqual(environmentValue(this, "CHATTICUS_OWNER_ID", 0), environmentValue(this, "CHATTICUS_OWNER_ID", 1));
	assert.notEqual(environmentValue(this, "CHATTICUS_MODEL_GATEWAY_TOKEN", 0), environmentValue(this, "CHATTICUS_MODEL_GATEWAY_TOKEN", 1));
});

Then("the gateway token binds the turn, the bot and the owner id of the container for 3600 seconds", function (this: ChatticusWorld) {
	const job = startJobOf(this);
	const verification = verifySessionToken(SCENARIO_GATEWAY_SIGNING_KEY, environmentValue(this, "CHATTICUS_MODEL_GATEWAY_TOKEN"), this.clock.now());
	assert.ok(verification.valid, JSON.stringify(verification));
	assert.deepEqual(verification.claims, {
		tenantId: job.tenantId,
		botId: job.botId,
		turnId: job.turnId,
		ownerId: environmentValue(this, "CHATTICUS_OWNER_ID"),
		expiresAtSeconds: Math.floor(this.clock.now().getTime() / 1000) + 3600,
	});
});

Then("STS was asked exactly {int} time(s) to assume the role {string}", function (this: ChatticusWorld, count: number, role: string) {
	const calls = ownerStartOf(this).sts.calls;
	assert.equal(calls.length, count);
	for (const call of calls) assert.equal(call.RoleArn, role);
});

Then("STS was not asked to assume a scoped role", function (this: ChatticusWorld) {
	assert.equal(ownerStartOf(this).sts.calls.length, 0);
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

Then("the session name is derived from the owner id and the session lasts {int} seconds", function (this: ChatticusWorld, seconds: number) {
	const call = ownerStartOf(this).sts.calls[0]!;
	const ownerId = environmentValue(this, "CHATTICUS_OWNER_ID");
	assert.ok(call.RoleSessionName.includes(ownerId), call.RoleSessionName);
	assert.match(call.RoleSessionName, /^[\w+=,.@-]{2,64}$/);
	assert.equal(call.DurationSeconds, seconds);
});

async function expectedOwnerPolicy(world: ChatticusWorld) {
	const job = startJobOf(world);
	const turn = await getTurn(world.turnDependencies(), job.tenantId, job.turnId);
	const computer = await ensureComputer(job.tenantId, { store: world.messagingStore(), ids: world.ids });
	return buildOwnerSessionPolicy({
		tenantId: job.tenantId,
		botId: job.botId,
		channelId: turn.channelId,
		bucketName: "pi-sessions-bucket",
		conversationsTableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/conversations-table",
		computerId: computer.computerId,
		snapshotBucketName: "snapshot-bucket",
		messagingTableArn: `arn:aws:dynamodb:us-east-1:123456789012:table/${world.messagingTable.tableName}`,
	});
}

Then("the session policy is the owner policy for the turn's conversation and the computer", async function (this: ChatticusWorld) {
	const call = ownerStartOf(this).sts.calls[0]!;
	assert.deepEqual(JSON.parse(call.Policy), await expectedOwnerPolicy(this));
});

Then("the session policy is within the STS size limit", function (this: ChatticusWorld) {
	const call = ownerStartOf(this).sts.calls[0]!;
	assert.ok(call.Policy.length <= SESSION_POLICY_MAXIMUM_CHARACTERS, `${call.Policy.length} characters`);
	assert.equal(call.Policy, JSON.stringify(JSON.parse(call.Policy)), "The policy carries whitespace that counts against the limit");
});

Then("the container environment holds the scoped credentials STS returned", function (this: ChatticusWorld) {
	assert.equal(environmentValue(this, "AWS_ACCESS_KEY_ID"), FAKE_SCOPED_CREDENTIALS.AccessKeyId);
	assert.equal(environmentValue(this, "AWS_SECRET_ACCESS_KEY"), FAKE_SCOPED_CREDENTIALS.SecretAccessKey);
	assert.equal(environmentValue(this, "AWS_SESSION_TOKEN"), FAKE_SCOPED_CREDENTIALS.SessionToken);
});

Then("the starter logged none of the gateway token, the scoped credentials, the invoke key and the signing key", function (this: ChatticusWorld) {
	const output = ownerStartOf(this).logs.join("\n");
	assert.ok(output.includes("owner_task_started"), "The starter logged nothing about the start");
	const secrets = [
		environmentValue(this, "CHATTICUS_MODEL_GATEWAY_TOKEN"),
		FAKE_SCOPED_CREDENTIALS.AccessKeyId,
		FAKE_SCOPED_CREDENTIALS.SecretAccessKey,
		FAKE_SCOPED_CREDENTIALS.SessionToken,
		OWNER_START_INVOKE_KEY,
		SCENARIO_GATEWAY_SIGNING_KEY,
	];
	for (const secret of secrets) assert.ok(!output.includes(secret), "A secret reached a log line");
});

When("the container takes over the turn with its task environment and is held after its tool ran", async function (this: ChatticusWorld) {
	const ownerId = environmentValue(this, "CHATTICUS_OWNER_ID");
	const job = activeTurnJobOf(this);
	const { ended, held } = await startComputerOwner(this, "started", { hold: true, job, workerId: ownerId });
	assert.ok(held);
	const early = ended.then((outcome) => {
		throw new Error(`The container ended ${outcome} before its tool ran.`);
	});
	await Promise.race([held.reached, early]);
});

function activeTurnJobOf(world: ChatticusWorld) {
	const job = startJobOf(world);
	return { tenantId: job.tenantId, turnId: activeTurnOf(world).turnId, botId: job.botId };
}

When("the container asks the model gateway for an answer with the token of its start", async function (this: ChatticusWorld) {
	const scenario = gatewayScenarioOf(this);
	const response = await fetch(`${await httpBaseUrl(this)}/orgs/${STORY_TENANT}/model-gateway/v1/responses`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "text/event-stream",
			authorization: `Bearer ${environmentValue(this, "CHATTICUS_MODEL_GATEWAY_TOKEN")}`,
		},
		body: JSON.stringify({ model: "gpt-5-nano", stream: true, input: [{ role: "user", content: "Say good morning." }] }),
	});
	scenario.lastBody = await response.text();
	scenario.lastResponse = response;
});

Then("the owner that took the turn over claimed it under the owner id of the start", async function (this: ChatticusWorld) {
	const job = startJobOf(this);
	const turn = await getTurn(this.turnDependencies(), job.tenantId, job.turnId);
	assert.equal(turn.claimedBy, environmentValue(this, "CHATTICUS_OWNER_ID"));
});
