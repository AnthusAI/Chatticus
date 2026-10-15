import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { OVERLAY_INDEX_OBJECT, overlayBlobObject, type OverlayEntry } from "@chatticus/host-protocol/edit-overlay";
import { EditOverlayRefusal, type EditOverlayDependencies, type EditOverlayRuntime } from "../src/domain/edit-overlay.ts";
import { StoreOverlayAuditSink } from "../src/domain/file-audit.ts";
import { FilesystemOverlayStore, type OverlayLocation, type OverlayStore } from "../src/snapshot/overlay-store.ts";
import { snapshotReadStoreOf } from "./computer-snapshot-files-support.ts";
import type { ChatticusWorld } from "./world.ts";

/** The outcome of one member edit step: recorded, or refused with the code and status the route would answer. */
export type EditAnswer =
	| { readonly kind: "recorded"; readonly outcome: unknown }
	| { readonly kind: "refused"; readonly refusal: EditOverlayRefusal };

/** What a scenario about the edit overlay remembers between its steps. */
export type OverlayScenario = {
	readonly store: OverlayStore;
	readonly audit: StoreOverlayAuditSink;
	readonly location: OverlayLocation;
	edit: EditAnswer | null;
	routeAnswer: { status: number; body: any } | null;
	ownerAnswer: { status: number; body: any } | null;
	sealedEntries: OverlayEntry[] | null;
	raceEdit: EditAnswer | null;
	raceSealEntries: OverlayEntry[] | null;
	firstOwner: { ownerId: string; generation: number; token: string } | null;
};

const scenarios = new WeakMap<ChatticusWorld, OverlayScenario>();

export const TENANT = "anthus";
export const COMPUTER_ID = "household-computer";

/** Create the scenario's overlay state on a local directory, or over the store the scenario gives. */
export function createOverlayScenario(world: ChatticusWorld, store?: OverlayStore): OverlayScenario {
	assert.ok(world.snapshotTmpdir, "The scenario has no temporary directory.");
	const scenario: OverlayScenario = {
		store: store ?? new FilesystemOverlayStore(join(world.snapshotTmpdir, "overlay-objects")),
		audit: new StoreOverlayAuditSink(world.messagingStore()),
		location: { tenantId: TENANT, computerId: COMPUTER_ID },
		edit: null,
		routeAnswer: null,
		ownerAnswer: null,
		sealedEntries: null,
		raceEdit: null,
		raceSealEntries: null,
		firstOwner: null,
	};
	scenarios.set(world, scenario);
	return scenario;
}

/** The scenario's overlay state; the Background creates it. */
export function overlayScenarioOf(world: ChatticusWorld): OverlayScenario {
	const scenario = scenarios.get(world);
	assert.ok(scenario, "The scenario has no edit overlay; its Background should create one.");
	return scenario;
}

/** What the Front Door is wired with: absent when the scenario made no overlay. */
export function editOverlayRuntimeOf(world: ChatticusWorld): EditOverlayRuntime | null {
	const scenario = scenarios.get(world);
	if (scenario === undefined) return null;
	return { overlay: scenario.store, snapshots: snapshotReadStoreOf(world), audit: scenario.audit };
}

/** The dependencies the overlay domain functions take, over the scenario's stores and clock. */
export function overlayDependenciesOf(world: ChatticusWorld): EditOverlayDependencies {
	const runtime = editOverlayRuntimeOf(world);
	assert.ok(runtime, "The scenario has no edit overlay.");
	return { ...runtime, store: world.messagingStore(), clock: world.clock, ids: world.ids, heartbeatTimeoutSeconds: world.heartbeatTimeoutSeconds };
}

/** The SHA-256 of text. */
export const hashOfText = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Resolve a table cell: `the hash of "x"` is the hash of x; anything else is itself. */
export function resolveHashCell(cell: string): string {
	const match = /^the hash of "(.*)"$/.exec(cell);
	return match === null ? cell : hashOfText(match[1]!);
}

/** The overlay index as it is stored now, or null when none was written. */
export async function storedIndexOf(world: ChatticusWorld): Promise<{ sealed: unknown; entries: OverlayEntry[] } | null> {
	const scenario = overlayScenarioOf(world);
	const read = await scenario.store.get(scenario.location, OVERLAY_INDEX_OBJECT);
	if (read.kind !== "found") return null;
	return JSON.parse(read.object.body.toString("utf8"));
}

/** The text of the blob with this hash, or null when the overlay holds none. */
export async function storedBlobText(world: ChatticusWorld, sha256: string): Promise<string | null> {
	const scenario = overlayScenarioOf(world);
	const read = await scenario.store.get(scenario.location, overlayBlobObject(sha256));
	return read.kind === "found" ? read.object.body.toString("utf8") : null;
}
