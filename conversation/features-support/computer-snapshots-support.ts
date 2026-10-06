import assert from "node:assert/strict";
import { join } from "node:path";
import { After } from "@cucumber/cucumber";
import { FilesystemSnapshotStore, type SnapshotObjectStore } from "../src/snapshot/store.ts";
import { ComputerHostDisk } from "../src/snapshot/host.ts";
import { diskOf } from "./computer-scenario.ts";
import type { ChatticusWorld } from "./world.ts";

const WORKSPACE_PATH_PREFIX = "/workspace/";

/** What a scenario about snapshots and relocation remembers between its steps. */
export type SnapshotRelocationScenario = {
	/** The browser sessions the computer's bots saved, by service; the host holds them in its browser profile. */
	readonly browserSessions: Map<string, string>;
	/** How the last relocate ended when it was refused; a scenario that expects a refusal inspects it. */
	relocateError: Error | null;
	/** How the last hydrate ended when it was refused. */
	hydrateError: Error | null;
	/** Whether a step looked at the refusal, so a refusal no scenario expected cannot pass unseen. */
	refusalInspected: boolean;
};

const scenarios = new WeakMap<ChatticusWorld, SnapshotRelocationScenario>();

/** The scenario's snapshot and relocation state, created on first use. */
export function snapshotRelocationOf(world: ChatticusWorld): SnapshotRelocationScenario {
	let scenario = scenarios.get(world);
	if (scenario === undefined) {
		scenario = { browserSessions: new Map(), relocateError: null, hydrateError: null, refusalInspected: false };
		scenarios.set(world, scenario);
	}
	return scenario;
}

/** The snapshot store every host of the scenario publishes to and hydrates from. */
export function sharedSnapshotStoreOf(world: ChatticusWorld): SnapshotObjectStore {
	if (world.snapshotStore !== null) {
		return world.snapshotStore as SnapshotObjectStore;
	}
	assert.ok(world.snapshotTmpdir, "The scenario has no snapshot directory.");
	world.snapshotStore = new FilesystemSnapshotStore(join(world.snapshotTmpdir, "store"));
	return world.snapshotStore as SnapshotObjectStore;
}

/** The profile file a saved browser session lives in. */
export function browserSessionPath(service: string): string {
	return `sessions/${service}`;
}

/**
 * Put what the computer's bots saved onto one host's live disk, as the host that serves the computer holds it.
 *
 * @param world The scenario world.
 * @param tenantId The organization whose computer it is.
 * @param disk The live disk of the host.
 */
export function writeComputerContentTo(world: ChatticusWorld, tenantId: string, disk: ComputerHostDisk): void {
	for (const [path, content] of diskOf(world, tenantId)) {
		assert.ok(path.startsWith(WORKSPACE_PATH_PREFIX), `Unexpected workspace path ${path}.`);
		disk.writeWorkspaceFile(path.slice(WORKSPACE_PATH_PREFIX.length), content);
	}
	for (const [service, session] of snapshotRelocationOf(world).browserSessions) {
		disk.writeBrowserProfileFile(browserSessionPath(service), session);
	}
}

/** A refusal no step inspected is a failure of the scenario, not a silent pass. */
After(function (this: ChatticusWorld) {
	const scenario = scenarios.get(this);
	if (scenario === undefined || scenario.refusalInspected) return;
	assert.equal(scenario.relocateError, null, `An unexpected relocate refusal went unchecked: ${scenario.relocateError?.message}`);
	assert.equal(scenario.hydrateError, null, `An unexpected hydrate refusal went unchecked: ${scenario.hydrateError?.message}`);
});
