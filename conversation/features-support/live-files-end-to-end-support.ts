import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { overlayBlobObject } from "@chatticus/host-protocol/edit-overlay";
import { HostDiskLifecycle } from "../../computer/host/src/host-disk-lifecycle.ts";
import { SealingOverlayApplier, type OverlayBlobReader } from "../../computer/host/src/overlay-applier.ts";
import { runtimeSupervisorClock } from "../../computer/host/src/supervisor-ports.ts";
import { computerOwnerScenarioOf } from "./computer-owner.ts";
import { fileRoutesOf } from "./computer-snapshot-files-support.ts";
import { COMPUTER_ID, TENANT, overlayScenarioOf } from "./edit-overlay-support.ts";
import { ScenarioFileHelperLauncher, UNUSED_FILE_HELPER_LAUNCHER } from "./fakes/fake-file-helper-launcher.ts";
import { longLivedOf, runUntil, settle, startLongLivedSupervisor } from "./steps/owner-long-lived.steps.ts";
import type { ChatticusWorld } from "./world.ts";

const MAXIMUM_REAL_WAITS_FOR_THE_SUPERVISOR = 300;
const MAXIMUM_WAKES = 400;
const REAL_PAUSE_MILLISECONDS = 10;

/** What a scenario about files shared by a member and a bot remembers between its steps. */
export type EndToEndScenario = {
	/** How many supervisors the scenario has started; each one gets a fresh disk, as each task of the computer does. */
	supervisorsStarted: number;
	/** The live root of the supervisor started last. */
	liveRoot: string | null;
};

const scenarios = new WeakMap<ChatticusWorld, EndToEndScenario>();

/** The scenario's end-to-end state, created on first use. */
export function endToEndOf(world: ChatticusWorld): EndToEndScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		scenario = { supervisorsStarted: 0, liveRoot: null };
		scenarios.set(world, scenario);
	}
	return scenario;
}

/**
 * The overlay blobs, read from the scenario's overlay store the way the supervisor reads them from the bucket: by content
 * hash, read only.
 */
class OverlayStoreBlobReader implements OverlayBlobReader {
	private readonly world: ChatticusWorld;

	constructor(world: ChatticusWorld) {
		this.world = world;
	}

	async read(sha256: string): Promise<Buffer | null> {
		const overlay = overlayScenarioOf(this.world);
		const answer = await overlay.store.get({ tenantId: TENANT, computerId: COMPUTER_ID }, overlayBlobObject(sha256));
		return answer.kind === "found" ? answer.object.body : null;
	}
}

/** The workspace directory of the supervisor started last. */
export function liveWorkspaceOf(world: ChatticusWorld): string {
	const root = endToEndOf(world).liveRoot;
	assert.ok(root, "No supervisor with a real computer disk was started in this scenario.");
	return join(root, "workspace");
}

/**
 * Start a supervisor on a fresh live disk, over the scenario's production routes: the disk lifecycle restores the saved
 * snapshot from the scenario's bucket and publishes to it, the overlay applier seals and applies the overlay through the
 * real file helper run in this process, and the tools of a bot's turn work in the same workspace directory.
 */
export async function startSupervisorOnRealDisk(world: ChatticusWorld): Promise<void> {
	assert.ok(world.snapshotTmpdir, "The scenario has no temporary directory.");
	const scenario = endToEndOf(world);
	scenario.supervisorsStarted += 1;
	const liveRoot = join(world.snapshotTmpdir, `real-disk-live-${scenario.supervisorsStarted}`);
	const workspaceRoot = join(liveRoot, "workspace");
	mkdirSync(workspaceRoot, { recursive: true });
	scenario.liveRoot = liveRoot;
	computerOwnerScenarioOf(world).workspace = workspaceRoot;
	const store = fileRoutesOf(world).publisherStore;
	assert.ok(store, "The scenario has no snapshot bucket for the computer file routes.");
	const helper = new ScenarioFileHelperLauncher(runtimeSupervisorClock, UNUSED_FILE_HELPER_LAUNCHER);
	helper.useRealProcess = false;
	await startLongLivedSupervisor(world, {
		liveRoot,
		workspaceRoot,
		fileHelperLauncher: helper,
		openDisk: ({ ownerId, generation, plane, clock, log }) =>
			new HostDiskLifecycle(plane, {
				tenantId: TENANT,
				ownerId,
				liveRoot,
				store,
				log,
				overlayApplier: new SealingOverlayApplier({
					ownerId,
					generation,
					plane,
					launcher: helper,
					workspaceRoot,
					blobs: new OverlayStoreBlobReader(world),
					clock,
					log,
				}),
			}),
	});
	const running = longLivedOf(world);
	await runUntil(world, "the supervisor is idle", () => running.supervisor.state === "idle");
	const pollsWhenIdle = running.pollCount;
	await runUntil(world, "the control plane has seen it idle", () => running.pollCount > pollsWhenIdle);
}

/**
 * Let a number of fake seconds go by for the supervisor: it wakes at each of its own sleeps that falls in the span, in order,
 * and the clock then moves to the end of the span. Work the supervisor does in real time (a restore, a publish, a helper)
 * finishes before time moves on.
 */
export async function letSecondsGoByForTheSupervisor(world: ChatticusWorld, seconds: number): Promise<void> {
	const scenario = longLivedOf(world);
	const target = world.clock.now().getTime() + seconds * 1000;
	for (let wakes = 0; wakes < MAXIMUM_WAKES; wakes += 1) {
		await settle(scenario);
		let next = scenario.clock.nextDeadlineMilliseconds();
		for (let waits = 0; next === undefined && waits < MAXIMUM_REAL_WAITS_FOR_THE_SUPERVISOR && scenario.exitCode === null; waits += 1) {
			await new Promise<void>((resolve) => setTimeout(resolve, REAL_PAUSE_MILLISECONDS));
			await settle(scenario);
			next = scenario.clock.nextDeadlineMilliseconds();
		}
		if (next === undefined || next > target) break;
		scenario.clock.wakeNext();
	}
	const behind = target - world.clock.now().getTime();
	if (behind > 0) world.clock.advanceSeconds(behind / 1000);
	await settle(scenario);
}
