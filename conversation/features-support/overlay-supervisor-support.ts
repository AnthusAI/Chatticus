import assert from "node:assert/strict";
import { cpSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { overlayEntrySchema, type OverlayEntry } from "@chatticus/host-protocol/edit-overlay";
import { ComputerHostDisk } from "../src/snapshot/host.ts";
import { snapshotUri } from "../src/snapshot/uri.ts";
import { blobHashOf } from "./fakes/fake-overlay-blob-store.ts";
import { treeHashOfDirectory } from "./live-file-supervisor-support.ts";
import { startSupervisor, supervisorScenarioOf } from "./owner-supervisor-support.ts";
import type { ChatticusWorld } from "./world.ts";

const TENANT = "anthus";
const COMPUTER_ID = "household-computer";
const REAL_PAUSE_MILLISECONDS = 10;
const REAL_PAUSES_PER_FAKE_SECOND = 8;

/** What an overlay scenario remembers between its steps. */
export type OverlayWorldState = {
	/** The disk the saved snapshot is built from. */
	readonly seedRoot: string;
	seeded: boolean;
	cacheMatched: boolean;
	nextRevision: number;
	outsideFile: string | null;
	/** The number of overlay clear reports the supervisor had made when a scenario marked a point in time. */
	clearReportsAtMark: number;
};

const states = new WeakMap<ChatticusWorld, OverlayWorldState>();

/** Create the overlay state of a scenario whose supervisor exists. */
export function createOverlayWorldState(world: ChatticusWorld): OverlayWorldState {
	assert.ok(world.snapshotTmpdir, "The scenario has no temporary directory.");
	const state: OverlayWorldState = {
		seedRoot: join(world.snapshotTmpdir, "seed-live"),
		seeded: false,
		cacheMatched: false,
		nextRevision: 1,
		outsideFile: null,
		clearReportsAtMark: 0,
	};
	mkdirSync(join(state.seedRoot, "workspace"), { recursive: true });
	states.set(world, state);
	return state;
}

/** The scenario's overlay state; the Background creates it. */
export function overlayWorldStateOf(world: ChatticusWorld): OverlayWorldState {
	const state = states.get(world);
	assert.ok(state, "The scenario has no overlay state; its Background should create it.");
	return state;
}

/** The directory the saved snapshot is built from. */
export const seedWorkspaceOf = (world: ChatticusWorld): string => join(overlayWorldStateOf(world).seedRoot, "workspace");

/** Put a file into the disk the saved snapshot will be built from. */
export function seedFile(world: ChatticusWorld, relativePath: string, content: string): void {
	const path = join(seedWorkspaceOf(world), relativePath);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
	overlayWorldStateOf(world).seeded = true;
}

/** Put a symbolic link into the disk the saved snapshot will be built from. */
export function seedSymlink(world: ChatticusWorld, relativePath: string, target: string): void {
	const path = join(seedWorkspaceOf(world), relativePath);
	mkdirSync(dirname(path), { recursive: true });
	symlinkSync(target, path);
	overlayWorldStateOf(world).seeded = true;
}

/** Publish the seeded disk as the computer's snapshot, as an earlier owner would have; nothing happens when nothing was seeded. */
export async function publishSeededSnapshot(world: ChatticusWorld): Promise<void> {
	const state = overlayWorldStateOf(world);
	if (!state.seeded) return;
	const scenario = supervisorScenarioOf(world);
	const liveRoot = scenario.environment["CHATTICUS_LIVE_ROOT"]!;
	let publishRoot = state.seedRoot;
	if (state.cacheMatched) {
		cpSync(join(state.seedRoot, "workspace"), join(liveRoot, "workspace"), { recursive: true, verbatimSymlinks: true });
		publishRoot = liveRoot;
	}
	const manifest = await new ComputerHostDisk(publishRoot, scenario.snapshotStore).publish({
		tenant_id: TENANT,
		computer_id: COMPUTER_ID,
		worker_id: "earlier-owner",
		log: () => undefined,
	});
	scenario.plane.snapshotUri = snapshotUri(TENANT, COMPUTER_ID, { bucket: scenario.snapshotStore.bucket });
	scenario.plane.snapshotChecksum = manifest.checksum;
	scenario.plane.snapshotGeneration = 1;
}

/** The tree hash of a folder of the seeded disk, as the person was shown it. */
export const seededTreeHashOf = (world: ChatticusWorld, livePath: string): string => treeHashOfDirectory(join(seedWorkspaceOf(world), livePath.replace(/^\/workspace\//, "")));

type EntryCommon = { readonly path: string; readonly revision: number; readonly edited_by: string; readonly edited_at: string; readonly conflict: null };

function commonOf(world: ChatticusWorld, path: string): EntryCommon {
	const state = overlayWorldStateOf(world);
	const revision = state.nextRevision;
	state.nextRevision += 1;
	return { path, revision, edited_by: "mia", edited_at: new Date(supervisorScenarioOf(world).clock.nowMilliseconds()).toISOString(), conflict: null };
}

/** Add a validated entry to the overlay the control plane holds. */
export function addOverlayEntry(world: ChatticusWorld, entry: unknown): OverlayEntry {
	const parsed = overlayEntrySchema.parse(entry);
	supervisorScenarioOf(world).plane.overlayEntries.push(parsed);
	return parsed;
}

/** An edit of a file, or the creation of one when no base text is given; the blob is stored under the hash of the content. */
export async function addPutEntry(
	world: ChatticusWorld,
	path: string,
	content: string,
	options: { readonly baseHash: string | null; readonly from?: { readonly path: string; readonly sha256: string }; readonly flaggedAsConflict?: boolean; readonly storeBlob?: boolean },
): Promise<OverlayEntry> {
	if (options.storeBlob !== false) await supervisorScenarioOf(world).overlayBlobs.put(content);
	return addOverlayEntry(world, {
		...commonOf(world, path),
		...(options.flaggedAsConflict === true ? { conflict: { reason: "changed", disk_sha256: null, found_at: new Date(supervisorScenarioOf(world).clock.nowMilliseconds()).toISOString() } } : {}),
		op: "put",
		sha256: blobHashOf(content),
		size: Buffer.byteLength(content, "utf8"),
		mode: "664",
		base_sha256: options.baseHash,
		from: options.from?.path ?? null,
		from_sha256: options.from?.sha256 ?? null,
	});
}

/** The entry of a new folder. */
export const addMkdirEntry = (world: ChatticusWorld, path: string): OverlayEntry => addOverlayEntry(world, { ...commonOf(world, path), op: "mkdir", mode: "775" });

/** The entry of a rename of a file. */
export const addFileMoveEntry = (world: ChatticusWorld, from: string, to: string, keptHash: string): OverlayEntry =>
	addOverlayEntry(world, { ...commonOf(world, to), op: "move", from, directory: false, sha256: keptHash, tree_sha256: null, size: 1, mode: "664" });

/** The entry of a rename of a folder. */
export const addDirectoryMoveEntry = (world: ChatticusWorld, from: string, to: string, treeHash: string): OverlayEntry =>
	addOverlayEntry(world, { ...commonOf(world, to), op: "move", from, directory: true, sha256: null, tree_sha256: treeHash, size: 0, mode: "775" });

/** The entry of a delete of a file. */
export const addFileDeleteEntry = (world: ChatticusWorld, path: string, baseHash: string): OverlayEntry =>
	addOverlayEntry(world, { ...commonOf(world, path), op: "delete", directory: false, recursive: false, base_sha256: baseHash, tree_sha256: null });

/** The entry of a delete of a folder that was empty when the person saw it. */
export const addEmptyFolderDeleteEntry = (world: ChatticusWorld, path: string): OverlayEntry =>
	addOverlayEntry(world, { ...commonOf(world, path), op: "delete", directory: true, recursive: false, base_sha256: null, tree_sha256: null });

async function realPause(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, REAL_PAUSE_MILLISECONDS));
}

/** Let the supervisor's real file work run without moving fake time. */
export async function lettingRealWorkRun(world: ChatticusWorld, pauses: number): Promise<void> {
	const scenario = supervisorScenarioOf(world);
	for (let pause = 0; pause < pauses; pause += 1) {
		await realPause();
		await scenario.clock.settle();
	}
}

/**
 * Let the supervisor run until the condition holds: real time for the file work it does on the disk, and fake time a second
 * at a time only while the condition still does not hold after the real work had its turn.
 *
 * @returns Whether the condition held within the fake seconds.
 */
export async function runUntil(world: ChatticusWorld, condition: () => boolean, maximumFakeSeconds: number): Promise<boolean> {
	const scenario = supervisorScenarioOf(world);
	for (let second = 0; second <= maximumFakeSeconds; second += 1) {
		for (let pause = 0; pause < REAL_PAUSES_PER_FAKE_SECOND; pause += 1) {
			await realPause();
			await scenario.clock.settle();
			if (condition()) return true;
		}
		await scenario.clock.advance(1000);
	}
	return condition();
}

/** Move fake time forward a second at a time, giving the supervisor's real file work its turn each second. */
export async function lettingSecondsPass(world: ChatticusWorld, seconds: number): Promise<void> {
	const scenario = supervisorScenarioOf(world);
	for (let second = 0; second < seconds; second += 1) {
		await lettingRealWorkRun(world, REAL_PAUSES_PER_FAKE_SECOND);
		await scenario.clock.advance(1000);
	}
	await runUntil(world, () => scenario.supervisor?.state !== "publishing", 0);
	await lettingRealWorkRun(world, 6);
}

/** Publish the seeded snapshot, start the supervisor, and run it until it left hydrating or ended. */
export async function startAndHydrate(world: ChatticusWorld): Promise<void> {
	const scenario = supervisorScenarioOf(world);
	await publishSeededSnapshot(world);
	await startSupervisor(world);
	await runUntil(world, () => scenario.exitCode !== null || (scenario.supervisor?.state !== "booting" && scenario.supervisor?.state !== "hydrating"), 60);
	await lettingRealWorkRun(world, 6);
}

/** The count of the lines the scenario's log holds for an event. */
export const logCountOf = (world: ChatticusWorld, event: string): number => supervisorScenarioOf(world).logs.filter((line) => line === event || line.startsWith(`${event} `)).length;

/** The number of files directly inside a real directory. */
export const entryCountOf = (directory: string): number => readdirSync(directory).length;
