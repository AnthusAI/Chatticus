import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import { observeOwnerTurn, ownerExitCodeFor, ownerLogEmitter, runOwnerEntryPoint } from "../../../computer/host/src/owner.ts";
import type { TurnTakeoverOutcome } from "../../src/turn/computer-owner.ts";
import { computerForOrganization, requestComputerHostStart } from "../../src/domain/computers.ts";
import type { SnapshotObjectStore } from "../../src/snapshot/store.ts";
import { activeTurnJob, computerOwnerDepsFor } from "../computer-owner.ts";
import { snapshotStoreForSupervisor } from "../owner-request-recording.ts";
import { hostDiskOf, lifecycleOf, LIFECYCLE_TENANT } from "../host-lifecycle-support.ts";
import { startSupervisedOwner, type SupervisedTurn } from "../supervised-owner-support.ts";
import type { ChatticusWorld } from "../world.ts";

type OwnerDiskScenario = {
	outcome: TurnTakeoverOutcome | null;
	failure: Error | null;
	stoppedDuringTurn: boolean | null;
	startGeneration: number;
	exitCode: number | null;
};

const scenarios = new WeakMap<ChatticusWorld, OwnerDiskScenario>();

function diskScenarioOf(world: ChatticusWorld): OwnerDiskScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		scenario = { outcome: null, failure: null, stoppedDuringTurn: null, startGeneration: 1, exitCode: null };
		scenarios.set(world, scenario);
	}
	return scenario;
}

function boundStoreOf(world: ChatticusWorld): SnapshotObjectStore {
	assert.ok(world.snapshotStore, "The scenario has no snapshot store bound to the host worker.");
	return world.snapshotStore as SnapshotObjectStore;
}

function passThroughLauncher(world: ChatticusWorld): string {
	assert.ok(world.snapshotTmpdir, "The scenario has no temporary directory.");
	const path = join(world.snapshotTmpdir, "owner-disk-shell");
	writeFileSync(path, '#!/bin/sh\nexec /bin/bash "$@"\n');
	chmodSync(path, 0o755);
	return path;
}

async function superviseOwner(world: ChatticusWorld, ownerId: string, turn: SupervisedTurn | null, store: SnapshotObjectStore = boundStoreOf(world)): Promise<void> {
	const scenario = diskScenarioOf(world);
	scenario.failure = null;
	const running = await startSupervisedOwner(world, ownerId, scenario.startGeneration, snapshotStoreForSupervisor(world, store), turn);
	scenario.exitCode = (await running.ended).exitCode;
}

function recordedTurn(
	world: ChatticusWorld,
	ownerId: string,
	work: (workspaceRoot: string) => Promise<TurnTakeoverOutcome>,
	ids: { turnId: string; botId?: string },
): SupervisedTurn {
	const scenario = diskScenarioOf(world);
	const log = ownerLogEmitter({ tenantId: LIFECYCLE_TENANT, turnId: ids.turnId, ownerId });
	return {
		...ids,
		work: async (workspaceRoot) => {
			scenario.stoppedDuringTurn = (await computerForOrganization(LIFECYCLE_TENANT, { store: world.messagingStore() })).stopped;
			try {
				scenario.outcome = await observeOwnerTurn(log, () => work(workspaceRoot));
				return ownerExitCodeFor(scenario.outcome);
			} catch (error) {
				scenario.failure = error as Error;
				return 70;
			}
		},
	};
}

Given("the starter claimed host start generation {int} for the computer", async function (this: ChatticusWorld, generation: number) {
	const store = this.messagingStore();
	const deps = {
		store,
		clock: this.clock,
		ids: this.ids,
		heartbeatTimeoutSeconds: this.heartbeatTimeoutSeconds,
		spend: { store, rollups: this.store, environment: this.budgetEnvironment, clock: this.clock },
	};
	const claim = await requestComputerHostStart(deps, LIFECYCLE_TENANT, "ryan");
	assert.equal(claim.hostStartGeneration, generation);
	assert.equal(claim.newlyClaimed, true);
});

Given("the owner was started for host start generation {int}", function (this: ChatticusWorld, generation: number) {
	diskScenarioOf(this).startGeneration = generation;
});

Then("the host start lease of generation {int} has ended", async function (this: ChatticusWorld, generation: number) {
	const computer = await computerForOrganization(LIFECYCLE_TENANT, { store: this.messagingStore() });
	assert.equal(computer.hostStartGeneration, generation);
	assert.equal(computer.hostStartLeaseExpiresAt, undefined);
});

Then("the host start lease of generation {int} is still held", async function (this: ChatticusWorld, generation: number) {
	const computer = await computerForOrganization(LIFECYCLE_TENANT, { store: this.messagingStore() });
	assert.equal(computer.hostStartGeneration, generation);
	assert.ok(computer.hostStartLeaseExpiresAt !== undefined && computer.hostStartLeaseExpiresAt.getTime() > this.clock.now().getTime());
});

When("the owner {string} runs the parked turn on its computer disk", async function (this: ChatticusWorld, ownerId: string) {
	const job = activeTurnJob(this);
	const deps = await computerOwnerDepsFor(this);
	await superviseOwner(
		this,
		ownerId,
		recordedTurn(this, ownerId, (workspaceRoot) => runOwnerEntryPoint(job, deps, { workspaceRoot, shellLauncherPath: passThroughLauncher(this), workerId: ownerId }), {
			turnId: job.turnId,
			botId: job.botId,
		}),
	);
});

When(
	"the owner {string} runs a turn that writes {string} containing {string} and then crashes",
	async function (this: ChatticusWorld, ownerId: string, path: string, content: string) {
		await superviseOwner(
			this,
			ownerId,
			recordedTurn(
				this,
				ownerId,
				async () => {
					hostDiskOf(this, ownerId).writeWorkspaceFile(path, content);
					throw new Error("the turn crashed");
				},
				{ turnId: "turn-that-crashes" },
			),
		);
	},
);

When("the owner {string} runs a turn while the snapshot downloads fail", async function (this: ChatticusWorld, ownerId: string) {
	const inner = boundStoreOf(this);
	const failing: SnapshotObjectStore = {
		bucket: inner.bucket,
		putPack: (uri, chunks) => inner.putPack(uri, chunks),
		putIndex: (uri, checksum, bytes) => inner.putIndex(uri, checksum, bytes),
		putManifest: (uri, manifest) => inner.putManifest(uri, manifest),
		getManifest: (uri) => inner.getManifest(uri),
		getIndexBytes: (uri, checksum) => inner.getIndexBytes(uri, checksum),
		getPackRange: (uri, offset, length) => inner.getPackRange(uri, offset, length),
		getPack: async () => {
			throw new Error("the download failed");
		},
	};
	await superviseOwner(this, ownerId, null, failing);
});

When(
	"the owner {string} is told to stop while its turn has written {string} containing {string}",
	async function (this: ChatticusWorld, ownerId: string, path: string, content: string) {
		const scenario = diskScenarioOf(this);
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reached: () => void = () => undefined;
		const turnReached = new Promise<void>((resolve) => {
			reached = resolve;
		});
		const running = await startSupervisedOwner(
			this,
			ownerId,
			scenario.startGeneration,
			snapshotStoreForSupervisor(this, boundStoreOf(this)),
			recordedTurn(
				this,
				ownerId,
				async () => {
					hostDiskOf(this, ownerId).writeWorkspaceFile(path, content);
					reached();
					await gate;
					return "done";
				},
				{ turnId: "turn-that-is-stopped" },
			),
		);
		await turnReached;
		running.supervisor.requestTermination();
		scenario.exitCode = (await running.ended).exitCode;
		release();
	},
);

Then("the owner's turn ended {string}", function (this: ChatticusWorld, outcome: string) {
	const scenario = diskScenarioOf(this);
	assert.equal(scenario.failure, null, scenario.failure?.message);
	assert.equal(scenario.outcome, outcome);
});

Then("the owner's run failed with {string}", function (this: ChatticusWorld, message: string) {
	const failure = diskScenarioOf(this).failure;
	assert.ok(failure, "The owner's run did not fail.");
	assert.ok(failure.message.includes(message), failure.message);
});

Then("the owner stopped with exit code {int}", function (this: ChatticusWorld, code: number) {
	assert.equal(diskScenarioOf(this).exitCode, code);
});

Then("the owner ran no turn", function (this: ChatticusWorld) {
	const scenario = diskScenarioOf(this);
	assert.equal(scenario.outcome, null);
	assert.equal(scenario.failure, null);
});

Then("the computer was running while the owner's turn ran", function (this: ChatticusWorld) {
	assert.equal(diskScenarioOf(this).stoppedDuringTurn, false);
});

Then("the organization's computer is stopped", async function (this: ChatticusWorld) {
	assert.equal((await computerForOrganization(LIFECYCLE_TENANT, { store: this.messagingStore() })).stopped, true);
});

Then("the organization's computer is running", async function (this: ChatticusWorld) {
	assert.equal((await computerForOrganization(LIFECYCLE_TENANT, { store: this.messagingStore() })).stopped, false);
});

Then("the disk was published {int} time(s)", function (this: ChatticusWorld, count: number) {
	const published = lifecycleOf(this).frontDoorRequests.filter((request) => request.url.includes("/snapshot/published"));
	assert.equal(published.length, count);
});
