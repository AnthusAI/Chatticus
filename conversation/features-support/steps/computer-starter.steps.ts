import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Given, Then, When } from "@cucumber/cucumber";
import {
	hostStarterFromEnvironment,
	NoOpHostStarter,
	OrganizationComputerHostStarter,
	type HostStarter,
	type StarterEnvironment,
} from "../../src/computer/host-starter.ts";
import { requestComputerHostStart } from "../../src/domain/computers.ts";
import type { Organization } from "../../src/domain/organizations.ts";
import { FakeAssumeRole, FakeEcs } from "../fakes/fake-ecs.ts";
import type { ChatticusWorld } from "../world.ts";

const execFileAsync = promisify(execFile);
const INFRA_DIRECTORY = fileURLToPath(new URL("../../../infra", import.meta.url));
const IAM_HARNESS_PATH = fileURLToPath(new URL("../../../infra/test/computer-starter-iam-harness.ts", import.meta.url));
const TSX_PATH = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
const DEPLOYMENT_ACCOUNT_ID = "123456789012";
const SINGLE_START_TENANT = "anthus";
const SINGLE_START_USER = "ryan";

type StarterScenarioState = {
	environment: StarterEnvironment;
	getOrganization: ((tenantId: string) => Promise<Organization>) | null;
	starter: HostStarter | null;
	synthesizedStarter: { statements: Array<Record<string, any>>; environment: Record<string, string> } | null;
	readonly ecs: FakeEcs;
	readonly assumeRole: FakeAssumeRole;
};

const states = new WeakMap<ChatticusWorld, StarterScenarioState>();

function starterState(world: ChatticusWorld): StarterScenarioState {
	let state = states.get(world);
	if (state === undefined) {
		state = { environment: {}, getOrganization: null, starter: null, synthesizedStarter: null, ecs: new FakeEcs(), assumeRole: new FakeAssumeRole() };
		states.set(world, state);
	}
	return state;
}

function seededOrganization(awsAccountId: string): Organization {
	return {
		tenantId: "anthus",
		name: "Anthus",
		status: "enabled",
		ownerUserId: "owner",
		createdAt: new Date("2026-08-31T12:00:00Z"),
		awsAccountId,
		awsCrossAccountRole: null,
		awsExternalId: null,
		awsSetupPath: "anthus-managed",
		setupFeeCents: null,
		assistedSetupSession: false,
		monthlyAwsSpendCeilingUsd: null,
	};
}

function starterFromEnvironment(world: ChatticusWorld, getOrganization: StarterScenarioState["getOrganization"]): HostStarter {
	const state = starterState(world);
	return hostStarterFromEnvironment(getOrganization, state.environment, {
		assumeRole: state.assumeRole.port,
		ecsClientFactory: () => state.ecs,
	});
}

Given("CHATTICUS_HOST_STARTER is ecs", function (this: ChatticusWorld) {
	starterState(this).environment = {
		CHATTICUS_HOST_STARTER: "ecs",
		CHATTICUS_DEPLOYMENT_AWS_ACCOUNT_ID: DEPLOYMENT_ACCOUNT_ID,
	};
});

Given("CHATTICUS_HOST_STARTER is not ecs", function (this: ChatticusWorld) {
	starterState(this).environment = {};
});

Given("an organization lookup is available for host start", function (this: ChatticusWorld) {
	starterState(this).getOrganization = async () => seededOrganization(DEPLOYMENT_ACCOUNT_ID);
});

Then("the host starter from environment is an OrganizationComputerHostStarter", function (this: ChatticusWorld) {
	const starter = starterFromEnvironment(this, async () => seededOrganization(DEPLOYMENT_ACCOUNT_ID));
	assert.ok(starter instanceof OrganizationComputerHostStarter);
});

Then("the host starter from environment is a no-op host starter", function (this: ChatticusWorld) {
	const state = starterState(this);
	state.starter = starterFromEnvironment(this, state.getOrganization);
	assert.ok(state.starter instanceof NoOpHostStarter);
});

When("the host starter from environment starts a host", async function (this: ChatticusWorld) {
	const starter = starterState(this).starter;
	assert.ok(starter, "No host starter was selected in this scenario.");
	await starter.startHost({ tenantId: "anthus", computerId: "household-computer", hostStartCount: 1, userId: "ryan" });
});

Then("no ECS RunTask was attempted", function (this: ChatticusWorld) {
	assert.deepEqual(starterState(this).ecs.runTaskCalls, []);
});

Then("no cross-account AssumeRole was attempted", function (this: ChatticusWorld) {
	assert.deepEqual(starterState(this).assumeRole.calls, []);
});

Given("development ThinTurn ComputerWorker is wired for ECS host start", async function (this: ChatticusWorld) {
	const { stdout } = await execFileAsync(TSX_PATH, [IAM_HARNESS_PATH], { cwd: INFRA_DIRECTORY, maxBuffer: 64 * 1024 * 1024 });
	const harnessLine = stdout.split("\n").find((line) => line.startsWith('{"statements"'));
	assert.ok(harnessLine, "The infra harness printed no synthesized IAM statements.");
	starterState(this).synthesizedStarter = JSON.parse(harnessLine);
});

function starterStatements(world: ChatticusWorld): Array<Record<string, any>> {
	const synthesized = starterState(world).synthesizedStarter;
	assert.ok(synthesized, "The ComputerWorker has not been synthesized in this scenario.");
	return synthesized.statements;
}

function allowedOn(world: ChatticusWorld, action: string): Array<Record<string, any>> {
	return starterStatements(world).filter(
		(statement) =>
			statement.Effect === "Allow" && (Array.isArray(statement.Action) ? statement.Action : [statement.Action]).includes(action),
	);
}

Then("ComputerWorker IAM allows ecs TagResource on summoned tasks", function (this: ChatticusWorld) {
	const tagging = allowedOn(this, "ecs:TagResource");
	assert.equal(tagging.length, 1, JSON.stringify(tagging));
	assert.equal(tagging[0]!.Resource, "arn:aws:ecs:us-east-1:111111111111:task/computers-cluster/*");
	assert.equal(allowedOn(this, "ecs:RunTask").length, 1);
	assert.equal(allowedOn(this, "sts:AssumeRole")[0]?.Resource, "arn:aws:iam::*:role/ChatticusOrganizationComputerRole");
	assert.equal(starterState(this).synthesizedStarter?.environment.CHATTICUS_HOST_STARTER, "ecs");
});

When("a turn requests a host start for that computer", async function (this: ChatticusWorld) {
	const store = this.messagingStore();
	await requestComputerHostStart(
		{ store, clock: this.clock, ids: this.ids, heartbeatTimeoutSeconds: this.heartbeatTimeoutSeconds, spend: { store, rollups: this.store, environment: this.budgetEnvironment, clock: this.clock } },
		SINGLE_START_TENANT,
		SINGLE_START_USER,
	);
});

When("the same turn retries the host start request", async function (this: ChatticusWorld) {
	const store = this.messagingStore();
	await requestComputerHostStart(
		{ store, clock: this.clock, ids: this.ids, heartbeatTimeoutSeconds: this.heartbeatTimeoutSeconds, spend: { store, rollups: this.store, environment: this.budgetEnvironment, clock: this.clock } },
		SINGLE_START_TENANT,
		SINGLE_START_USER,
	);
});

Then("the platform still has one logical host start", async function (this: ChatticusWorld) {
	assert.equal((await this.messagingStore().getComputer(SINGLE_START_TENANT))?.hostStartGeneration, 1);
});
