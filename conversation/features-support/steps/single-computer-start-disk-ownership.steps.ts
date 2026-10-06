import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import {
	acquireComputerDiskWrite,
	HOST_START_LEASE_SECONDS,
	requestComputerHostStart,
	type HostStartClaim,
} from "../../src/domain/computers.ts";
import type { ChatticusWorld } from "../world.ts";

const OWNERSHIP_TENANT = "anthus";
const OWNERSHIP_USER = "ryan";

type DiskOwnershipScenario = {
	claims: HostStartClaim[];
	hostAWrites: boolean | null;
	hostBWrites: boolean | null;
};

const scenarios = new WeakMap<ChatticusWorld, DiskOwnershipScenario>();

function ownershipOf(world: ChatticusWorld): DiskOwnershipScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		scenario = { claims: [], hostAWrites: null, hostBWrites: null };
		scenarios.set(world, scenario);
	}
	return scenario;
}

async function requestHostStart(world: ChatticusWorld): Promise<HostStartClaim> {
	const store = world.messagingStore();
	const claim = await requestComputerHostStart(
		{ store, clock: world.clock, ids: world.ids, spend: { store, rollups: world.store, environment: world.budgetEnvironment, clock: world.clock } },
		OWNERSHIP_TENANT,
		OWNERSHIP_USER,
	);
	ownershipOf(world).claims.push(claim);
	return claim;
}

Given("a turn has requested a host start for that computer", async function (this: ChatticusWorld) {
	await requestHostStart(this);
});

When("two eligible turns request that computer concurrently", async function (this: ChatticusWorld) {
	await Promise.all([requestHostStart(this), requestHostStart(this)]);
	const scenario = ownershipOf(this);
	const deps = { store: this.messagingStore() };
	scenario.hostAWrites = await acquireComputerDiskWrite(OWNERSHIP_TENANT, "host-a", deps);
	scenario.hostBWrites = await acquireComputerDiskWrite(OWNERSHIP_TENANT, "host-b", deps);
});

When("the host start lease expires without a live writer", async function (this: ChatticusWorld) {
	this.clock.advanceSeconds(HOST_START_LEASE_SECONDS + 1);
	const computer = await this.messagingStore().getComputer(OWNERSHIP_TENANT);
	assert.equal(computer?.liveWriterHostId, undefined);
});

When("another turn requests a host start for that computer", async function (this: ChatticusWorld) {
	await requestHostStart(this);
});

Then("the platform issues one host start request", function (this: ChatticusWorld) {
	const claims = ownershipOf(this).claims;
	assert.equal(claims.length, 2);
	assert.equal(claims.filter((claim) => claim.newlyClaimed).length, 1);
	assert.deepEqual(new Set(claims.map((claim) => claim.hostStartGeneration)), new Set([1]));
});

Then("both turns wait for the same computer identity", function (this: ChatticusWorld) {
	const claims = ownershipOf(this).claims;
	assert.equal(claims.length, 2);
	assert.equal(new Set(claims.map((claim) => claim.computerId)).size, 1);
});

Then("at most one live host may write that computer", async function (this: ChatticusWorld) {
	const scenario = ownershipOf(this);
	assert.equal(scenario.hostAWrites, true);
	assert.equal(scenario.hostBWrites, false);
	assert.equal((await this.messagingStore().getComputer(OWNERSHIP_TENANT))?.liveWriterHostId, "host-a");
});

Then("the platform has issued two logical host starts", async function (this: ChatticusWorld) {
	assert.equal((await this.messagingStore().getComputer(OWNERSHIP_TENANT))?.hostStartGeneration, 2);
});

Then("the wedged disk write lock is cleared", async function (this: ChatticusWorld) {
	assert.equal((await this.messagingStore().getComputer(OWNERSHIP_TENANT))?.liveWriterHostId, undefined);
});
