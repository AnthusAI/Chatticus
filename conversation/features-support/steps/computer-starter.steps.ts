import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

const DEPLOYMENT_ACCOUNT_ID = "123456789012";
const SINGLE_START_TENANT = "anthus";
const SINGLE_START_USER = "ryan";

type StarterScenarioState = {
	environment: StarterEnvironment;
	getOrganization: ((tenantId: string) => Promise<Organization>) | null;
	starter: HostStarter | null;
	hostStartSource: string;
	readonly ecs: FakeEcs;
	readonly assumeRole: FakeAssumeRole;
};

const states = new WeakMap<ChatticusWorld, StarterScenarioState>();

function starterState(world: ChatticusWorld): StarterScenarioState {
	let state = states.get(world);
	if (state === undefined) {
		state = { environment: {}, getOrganization: null, starter: null, hostStartSource: "", ecs: new FakeEcs(), assumeRole: new FakeAssumeRole() };
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

Given("development ThinTurn ComputerWorker is wired for ECS host start", function (this: ChatticusWorld) {
	starterState(this).hostStartSource = readFileSync(new URL("../../../infra/lib/computer-host-start.ts", import.meta.url), "utf8");
});

Then("ComputerWorker IAM allows ecs TagResource on summoned tasks", function (this: ChatticusWorld) {
	const text = starterState(this).hostStartSource;
	assert.ok(text.includes("ecs:TagResource"));
	assert.ok(text.includes("ecs:RunTask"));
	assert.ok(text.includes("sts:AssumeRole"));
});

When("a turn requests a host start for that computer", async function (this: ChatticusWorld) {
	const store = this.messagingStore();
	await requestComputerHostStart(
		{ store, clock: this.clock, ids: this.ids, spend: { store, rollups: this.store, environment: this.budgetEnvironment, clock: this.clock } },
		SINGLE_START_TENANT,
		SINGLE_START_USER,
	);
});

When("the same turn retries the host start request", async function (this: ChatticusWorld) {
	const store = this.messagingStore();
	await requestComputerHostStart(
		{ store, clock: this.clock, ids: this.ids, spend: { store, rollups: this.store, environment: this.budgetEnvironment, clock: this.clock } },
		SINGLE_START_TENANT,
		SINGLE_START_USER,
	);
});

Then("the platform still has one logical host start", async function (this: ChatticusWorld) {
	assert.equal((await this.messagingStore().getComputer(SINGLE_START_TENANT))?.hostStartGeneration, 1);
});
