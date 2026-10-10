import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Then, When } from "@cucumber/cucumber";
import { observeOwnerRun, runOwnerEntryPoint, runOwnerOnComputerDisk, type OwnerEntryPointOutcome } from "../../../computer/host/src/owner.ts";
import { consoleLogEmitter } from "../../src/observability/log-line.ts";
import { computerForOrganization } from "../../src/domain/computers.ts";
import type { SnapshotObjectStore } from "../../src/snapshot/store.ts";
import { activeTurnJob, computerOwnerDepsFor } from "../computer-owner.ts";
import { snapshotStoreForOwner } from "../owner-request-recording.ts";
import { ensureHostWorker, hostClientFor, hostDiskOf, lifecycleOf, LIFECYCLE_TENANT } from "../host-lifecycle-support.ts";
import type { ChatticusWorld } from "../world.ts";

type OwnerDiskScenario = {
	outcome: OwnerEntryPointOutcome | null;
	failure: Error | null;
	stoppedDuringTurn: boolean | null;
	terminate: (() => Promise<void>) | null;
};

const scenarios = new WeakMap<ChatticusWorld, OwnerDiskScenario>();

function diskScenarioOf(world: ChatticusWorld): OwnerDiskScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		scenario = { outcome: null, failure: null, stoppedDuringTurn: null, terminate: null };
		scenarios.set(world, scenario);
	}
	return scenario;
}

const NO_TIMER = { start: () => 0, stop: () => undefined };

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

async function runOwnerOnDisk(
	world: ChatticusWorld,
	ownerId: string,
	run: (workspaceRoot: string) => Promise<OwnerEntryPointOutcome>,
	store: SnapshotObjectStore = snapshotStoreForOwner(world, boundStoreOf(world)),
	turnId?: string,
): Promise<void> {
	const scenario = diskScenarioOf(world);
	await ensureHostWorker(world, LIFECYCLE_TENANT, ownerId);
	const disk = hostDiskOf(world, ownerId);
	const plane = hostClientFor(world, ownerId);
	scenario.failure = null;
	const log = consoleLogEmitter({ tenant_id: LIFECYCLE_TENANT, ...(turnId === undefined ? {} : { turn_id: turnId }), owner_id: ownerId });
	try {
		scenario.outcome = await observeOwnerRun(log, {}, () =>
			runOwnerOnComputerDisk(
				plane,
				{
					tenantId: LIFECYCLE_TENANT,
					workerId: ownerId,
					log,
					...(turnId === undefined ? {} : { turnId }),
					liveRoot: disk.liveRoot,
					store,
					heartbeatTimer: NO_TIMER,
					onTerminate: (handler) => {
						scenario.terminate = handler;
					},
				},
				async () => {
					scenario.stoppedDuringTurn = (await computerForOrganization(LIFECYCLE_TENANT, { store: world.messagingStore() })).stopped;
					return run(join(disk.liveRoot, "workspace"));
				},
			),
		);
	} catch (error) {
		scenario.failure = error as Error;
	}
}

When("the owner {string} runs the parked turn on its computer disk", async function (this: ChatticusWorld, ownerId: string) {
	const job = activeTurnJob(this);
	const deps = await computerOwnerDepsFor(this);
	await runOwnerOnDisk(
		this,
		ownerId,
		(workspaceRoot) =>
			runOwnerEntryPoint({ claim: async () => job }, deps, { workspaceRoot, shellLauncherPath: passThroughLauncher(this), workerId: ownerId }),
		undefined,
		job.turnId,
	);
});

When(
	"the owner {string} runs a turn that writes {string} containing {string} and then crashes",
	async function (this: ChatticusWorld, ownerId: string, path: string, content: string) {
		await runOwnerOnDisk(this, ownerId, async () => {
			hostDiskOf(this, ownerId).writeWorkspaceFile(path, content);
			throw new Error("the turn crashed");
		});
	},
);

When("the owner {string} runs a turn while the snapshot downloads fail", async function (this: ChatticusWorld, ownerId: string) {
	const inner = boundStoreOf(this);
	const failing: SnapshotObjectStore = {
		bucket: inner.bucket,
		put: (...parts) => inner.put(...parts),
		getManifest: (...parts) => inner.getManifest(...parts),
		getPack: async () => {
			throw new Error("the download failed");
		},
	} as SnapshotObjectStore;
	await runOwnerOnDisk(
		this,
		ownerId,
		async () => {
			assert.fail("The turn must not run when the disk could not be hydrated.");
		},
		failing,
	);
});

When(
	"the owner {string} is told to stop while its turn has written {string} containing {string}",
	async function (this: ChatticusWorld, ownerId: string, path: string, content: string) {
		const scenario = diskScenarioOf(this);
		scenario.terminate = null;
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reached: () => void = () => undefined;
		const turnReached = new Promise<void>((resolve) => {
			reached = resolve;
		});
		const running = runOwnerOnDisk(this, ownerId, async () => {
			hostDiskOf(this, ownerId).writeWorkspaceFile(path, content);
			reached();
			await gate;
			return "done";
		});
		await turnReached;
		const terminate = scenario.terminate as (() => Promise<void>) | null;
		assert.ok(terminate, "The owner registered nothing to run when it is told to stop.");
		await terminate();
		release();
		await running;
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
