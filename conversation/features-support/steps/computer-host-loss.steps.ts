import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { acquireComputerDiskWrite } from "../../src/domain/computers.ts";
import type { Computer } from "../../src/store/codecs/computer.ts";
import { hostNamed, registerHost, STORY_TENANT } from "../computer-scenario.ts";
import type { ChatticusWorld } from "../world.ts";

const LOSS_SNAPSHOT_URI = "s3://household-snapshots/anthus/household-computer.tar.zst";
const LOST_HOST_SECONDS = 61;

async function computerNow(world: ChatticusWorld): Promise<Computer> {
	const computer = await world.messagingStore().getComputer(STORY_TENANT);
	assert.ok(computer, "The organization has no computer.");
	return computer;
}

Given("the computer has a published snapshot", async function (this: ChatticusWorld) {
	const computer = await computerNow(this);
	await this.messagingStore().putComputer({ ...computer, snapshotUri: LOSS_SNAPSHOT_URI, snapshotChecksum: "sha256:published", snapshotGeneration: 3 });
});

Given(
	"host {string} is running the computer with unpublished writes and holds the live disk lock",
	async function (this: ChatticusWorld, workerId: string) {
		const host = await registerHost(this, STORY_TENANT, workerId, "fargate");
		await host.heartbeat();
		const store = this.messagingStore();
		assert.equal(await acquireComputerDiskWrite(STORY_TENANT, workerId, { store }), true);
		assert.equal(await store.markComputerDiskDirty(STORY_TENANT), true);
	},
);

Given("host {string} claimed the pending computer action", async function (this: ChatticusWorld, workerId: string) {
	const action = await hostNamed(this, workerId).claim();
	assert.ok(action, `Host ${workerId} found no action to claim.`);
});

Given("the computer record claims unpublished writes although no host is registered", async function (this: ChatticusWorld) {
	const store = this.messagingStore();
	assert.equal(await store.markComputerDiskDirty(STORY_TENANT), true);
	assert.equal(await acquireComputerDiskWrite(STORY_TENANT, "vanished-host", { store }), true);
	assert.deepEqual(await store.listWorkers(STORY_TENANT), []);
});

When("host {string} is killed before it can report", function (this: ChatticusWorld, _workerId: string) {
	this.clock.advanceSeconds(LOST_HOST_SECONDS);
});

When("{int} seconds pass and host {string} sends a heartbeat", async function (this: ChatticusWorld, seconds: number, workerId: string) {
	this.clock.advanceSeconds(seconds);
	await hostNamed(this, workerId).heartbeat();
});

Then("the computer record is settled as stopped with no unpublished writes", async function (this: ChatticusWorld) {
	const computer = await computerNow(this);
	assert.equal(computer.stopped, true);
	assert.equal(computer.diskDirty, false);
	assert.equal(computer.liveWriterHostId, undefined);
	assert.equal(computer.workspaceReady, false);
});

Then("the computer must hydrate the published snapshot", async function (this: ChatticusWorld) {
	const computer = await computerNow(this);
	assert.equal(computer.hydrateRequired, true);
	assert.equal(computer.snapshotUri, LOSS_SNAPSHOT_URI);
	assert.equal(computer.snapshotGeneration, 3);
});

Then("the computer does not need to hydrate", async function (this: ChatticusWorld) {
	assert.equal((await computerNow(this)).hydrateRequired, false);
});

Then("the computer record shows the loss of the host of generation {int}", async function (this: ChatticusWorld, generation: number) {
	const computer = await computerNow(this);
	assert.ok(computer.hostLostAt instanceof Date, "The loss of the host was not recorded.");
	assert.equal(computer.hostLostGeneration, generation);
});

Then("the computer record shows no host loss", async function (this: ChatticusWorld) {
	const computer = await computerNow(this);
	assert.equal(computer.hostLostAt, undefined);
	assert.equal(computer.hostLostGeneration, undefined);
});

Then("the computer is still running with unpublished writes", async function (this: ChatticusWorld) {
	const computer = await computerNow(this);
	assert.equal(computer.stopped, false);
	assert.equal(computer.diskDirty, true);
});

Then("no host holds the live disk lock", async function (this: ChatticusWorld) {
	assert.equal((await computerNow(this)).liveWriterHostId, undefined);
});

Then("host {string} can take the live disk lock", async function (this: ChatticusWorld, hostId: string) {
	assert.equal(await acquireComputerDiskWrite(STORY_TENANT, hostId, { store: this.messagingStore() }), true);
});
