import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OVERLAY_INDEX_OBJECT } from "@chatticus/host-protocol/edit-overlay";
import {
	EditOverlayRefusal,
	changeOverlay,
	clearOverlay,
	discardOverlayEntry,
	readOverlayState,
	sealBinds,
	sealOverlay,
	unsealOverlay,
	type EditOverlayDependencies,
	type OverlayAuditRecord,
} from "../src/domain/edit-overlay.ts";
import { OwnerRefusal } from "../src/domain/owner-supervisor.ts";
import { SnapshotObjectMissingError } from "../src/snapshot/pack.ts";
import { FilesystemOverlayStore, type OverlayLocation, type OverlayStore } from "../src/snapshot/overlay-store.ts";
import type { Computer } from "../src/store/codecs/computer.ts";
import type { Worker } from "../src/store/codecs/worker.ts";
import { hashOfText } from "./overlay-fixtures.ts";

const location: OverlayLocation = { tenantId: "anthus", computerId: "household" };
const NOW = new Date("2026-10-12T12:00:00.000Z");
const owner = { tenantId: "anthus", ownerId: "owner-1", startGeneration: 1 };

let directory = "";

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "edit-overlay-domain-"));
});
afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

const computer = (overrides: Partial<Computer> = {}): Computer => ({
	computerId: "household",
	tenantId: "anthus",
	policy: "prefer_local",
	stopped: false,
	modelReady: true,
	workspaceReady: true,
	browserReady: false,
	hostStartGeneration: 1,
	hostStartDispatchedGeneration: 1,
	snapshotGeneration: 0,
	diskDirty: false,
	hydrateRequired: false,
	ownerId: "owner-1",
	ownerGeneration: 1,
	...overrides,
});

const worker = (overrides: Partial<Worker> = {}): Worker =>
	({ workerId: "owner-1", tenantId: "anthus", computerId: "household", lastHeartbeatAt: NOW, pollState: "hydrating", ...overrides }) as Worker;

/** A store that runs a hook just before the next conditional put of the index, so a competing writer can win first. */
class InterleavingStore implements OverlayStore {
	readonly inner: FilesystemOverlayStore;
	beforeSwap: Array<() => Promise<void>> = [];
	constructor(root: string) {
		this.inner = new FilesystemOverlayStore(root);
	}
	get(...args: Parameters<OverlayStore["get"]>) {
		return this.inner.get(...args);
	}
	async putIfAbsent(...args: Parameters<OverlayStore["putIfAbsent"]>) {
		if (args[1] === OVERLAY_INDEX_OBJECT) {
			const hook = this.beforeSwap.shift();
			if (hook !== undefined) await hook();
		}
		return this.inner.putIfAbsent(...args);
	}
	async putIfMatch(...args: Parameters<OverlayStore["putIfMatch"]>) {
		if (args[1] === OVERLAY_INDEX_OBJECT) {
			const hook = this.beforeSwap.shift();
			if (hook !== undefined) await hook();
		}
		return this.inner.putIfMatch(...args);
	}
	delete(...args: Parameters<OverlayStore["delete"]>) {
		return this.inner.delete(...args);
	}
}

function make(options: { computerRecord?: Computer; workerRecord?: Worker | null; auditFails?: boolean } = {}) {
	const store = new InterleavingStore(directory);
	const records: OverlayAuditRecord[] = [];
	let counter = 0;
	const deps: EditOverlayDependencies = {
		overlay: store,
		snapshots: {
			bucket: "chatticus",
			getManifest: () => {
				throw new SnapshotObjectMissingError("none");
			},
			getIndexBytes: () => {
				throw new SnapshotObjectMissingError("none");
			},
			getPackRange: () => {
				throw new SnapshotObjectMissingError("none");
			},
		},
		audit: {
			begin: async (record) => {
				if (options.auditFails === true) throw new Error("down");
				records.push(record);
			},
			finish: async () => undefined,
		},
		store: {
			getComputer: async () => options.computerRecord ?? computer(),
			getWorker: async () => (options.workerRecord === undefined ? worker() : options.workerRecord),
		},
		clock: { now: () => NOW },
		ids: { next: () => String(++counter) },
		heartbeatTimeoutSeconds: 30,
	};
	return { deps, store, records };
}

const create = (deps: EditOverlayDependencies, userId: string, path: string, content: string) =>
	changeOverlay(deps, { tenantId: "anthus", userId, request: { op: "put", path, content, precondition: { type: "if_none_match" } } });

async function refusalOf(run: () => Promise<unknown>): Promise<EditOverlayRefusal> {
	try {
		await run();
	} catch (error) {
		if (error instanceof EditOverlayRefusal) return error;
		throw error;
	}
	throw new Error("expected a refusal");
}

describe("the swap loop", () => {
	it("re-judges after a lost swap and keeps both edits to different paths", async () => {
		const { deps, store } = make();
		store.beforeSwap.push(async () => {
			await create({ ...deps, overlay: store.inner }, "ryan", "/workspace/other.md", "other");
		});
		await create(deps, "mia", "/workspace/mine.md", "mine");
		const { index } = await readOverlayState(deps, location);
		expect(index.entries.map((entry) => entry.path).sort()).toEqual(["/workspace/mine.md", "/workspace/other.md"]);
	});

	it("answers 409 with the winner's hash when the lost swap changed the effective hash of the same path", async () => {
		const { deps, store } = make();
		await create(deps, "mia", "/workspace/plan.md", "v1");
		store.beforeSwap.push(async () => {
			await changeOverlay({ ...deps, overlay: store.inner }, {
				tenantId: "anthus",
				userId: "ryan",
				request: { op: "put", path: "/workspace/plan.md", content: "from Ryan", precondition: { type: "if_match", sha256: hashOfText("v1") } },
			});
		});
		const refusal = await refusalOf(() =>
			changeOverlay(deps, {
				tenantId: "anthus",
				userId: "mia",
				request: { op: "put", path: "/workspace/plan.md", content: "from Mia", precondition: { type: "if_match", sha256: hashOfText("v1") } },
			}),
		);
		expect(refusal.code).toBe("precondition_failed");
		expect(refusal.currentSha256).toBe(hashOfText("from Ryan"));
	});

	it("tells the member to wait when the seal wins the swap, and leaves no entry", async () => {
		const { deps, store } = make();
		store.beforeSwap.push(async () => {
			await sealOverlay({ ...deps, overlay: store.inner }, owner);
		});
		const refusal = await refusalOf(() => create(deps, "mia", "/workspace/a.md", "a"));
		expect(refusal.code).toBe("computer_starting");
		expect(refusal.retryAfterMs).toBe(2000);
		const { index } = await readOverlayState(deps, location);
		expect(index.entries).toEqual([]);
		expect(index.sealed?.owner_id).toBe("owner-1");
	});

	it("puts the edit in the sealed set when the edit wins the swap", async () => {
		const { deps, store } = make();
		await create(deps, "mia", "/workspace/seed.md", "seed");
		store.beforeSwap.push(async () => {
			await create({ ...deps, overlay: store.inner }, "mia", "/workspace/a.md", "a");
		});
		const sealed = await sealOverlay(deps, owner);
		expect(sealed.entries.map((entry) => entry.path).sort()).toEqual(["/workspace/a.md", "/workspace/seed.md"]);
	});

	it("gives up after three lost swaps", async () => {
		const { deps, store } = make();
		let rival = 0;
		const interfere = async () => {
			rival += 1;
			await create({ ...deps, overlay: store.inner }, "ryan", `/workspace/rival-${rival}.md`, "r");
		};
		store.beforeSwap.push(interfere, interfere, interfere);
		const refusal = await refusalOf(() => create(deps, "mia", "/workspace/mine.md", "mine"));
		expect(refusal.code).toBe("overlay_contended");
		expect(refusal.status).toBe(503);
	});

	it("does nothing and writes no record when the audit store is down", async () => {
		const { deps } = make({ auditFails: true });
		const refusal = await refusalOf(() => create(deps, "mia", "/workspace/a.md", "a"));
		expect(refusal.code).toBe("audit_unavailable");
		expect((await readOverlayState(deps, location)).index.entries).toEqual([]);
	});

	it("writes the blob before the index and never keys an object by a path", async () => {
		const { deps, store } = make();
		await create(deps, "mia", "/workspace/a.md", "a");
		expect(await store.inner.get(location, `overlay/blobs/${hashOfText("a")}`)).toMatchObject({ kind: "found" });
	});
});

describe("the seal rules", () => {
	it("binds only while its owner is the current owner of that generation and alive", async () => {
		const { deps } = make();
		await sealOverlay(deps, owner);
		const { index } = await readOverlayState(deps, location);
		expect(sealBinds(index, computer(), worker(), NOW, 30)).toBe(true);
		expect(sealBinds(index, computer({ ownerGeneration: 2 }), worker(), NOW, 30)).toBe(false);
		expect(sealBinds(index, computer({ ownerId: "other" }), worker(), NOW, 30)).toBe(false);
		expect(sealBinds(index, computer(), worker({ lastHeartbeatAt: new Date(NOW.getTime() - 31000) }), NOW, 30)).toBe(false);
		expect(sealBinds(index, computer(), null, NOW, 30)).toBe(false);
	});

	it("returns the seal the owner already holds without writing again", async () => {
		const { deps, store } = make();
		await sealOverlay(deps, owner);
		const before = await store.inner.get(location, OVERLAY_INDEX_OBJECT);
		await sealOverlay(deps, owner);
		expect(await store.inner.get(location, OVERLAY_INDEX_OBJECT)).toEqual(before);
	});

	it("replaces a stale seal on the next member write", async () => {
		const { deps } = make({ workerRecord: worker({ lastHeartbeatAt: new Date(NOW.getTime() - 60000) }) });
		await sealOverlay(deps, owner);
		await create(deps, "mia", "/workspace/a.md", "a");
		expect((await readOverlayState(deps, location)).index.sealed).toBeNull();
	});

	it("says the computer is stopping when the owner is", async () => {
		const { deps } = make({ workerRecord: worker({ pollState: "stopping" }) });
		await sealOverlay(deps, owner);
		const refusal = await refusalOf(() => create(deps, "mia", "/workspace/a.md", "a"));
		expect(refusal.code).toBe("computer_stopping");
		expect(refusal.retryAfterMs).toBe(5000);
	});

	it("unseals only its own seal", async () => {
		const { deps } = make();
		await sealOverlay(deps, owner);
		await unsealOverlay(deps, { ...owner, ownerId: "someone-else" });
		expect((await readOverlayState(deps, location)).index.sealed).not.toBeNull();
		await unsealOverlay(deps, owner);
		expect((await readOverlayState(deps, location)).index.sealed).toBeNull();
	});

	it("never throws from an unseal that fails", async () => {
		const { deps } = make();
		await expect(unsealOverlay({ ...deps, store: { getComputer: async () => null, getWorker: async () => null } }, owner)).resolves.toBeUndefined();
	});
});

describe("clearing", () => {
	async function sealedWithEntries() {
		const made = make({ computerRecord: computer({ snapshotGeneration: 0 }) });
		await create(made.deps, "mia", "/workspace/a.md", "a");
		const sealed = await sealOverlay(made.deps, owner);
		return { ...made, sealed };
	}

	it("refuses a caller that holds no seal", async () => {
		const { deps } = make();
		await expect(clearOverlay(deps, owner, { cleared: [{ path: "/workspace/a.md", revision: 1 }], conflicts: [] })).rejects.toThrow(OwnerRefusal);
	});

	it("refuses a caller that is not the owner or the generation that holds the seal", async () => {
		const { deps } = await sealedWithEntries();
		const request = { cleared: [{ path: "/workspace/a.md", revision: 1 }], conflicts: [] };
		await expect(clearOverlay(deps, { ...owner, ownerId: "owner-2" }, request)).rejects.toThrow(OwnerRefusal);
		await expect(clearOverlay(deps, { ...owner, startGeneration: 2 }, request)).rejects.toThrow(OwnerRefusal);
	});

	it("keeps an entry until a publish is on record", async () => {
		const { deps } = await sealedWithEntries();
		expect(await clearOverlay(deps, owner, { cleared: [{ path: "/workspace/a.md", revision: 1 }], conflicts: [] })).toEqual({ remaining: 1 });
	});

	it("clears the named revision once a publish is on record, and not another revision", async () => {
		const { deps } = await sealedWithEntries();
		const recorded = { ...deps, store: { ...deps.store, getComputer: async () => computer({ snapshotGeneration: 1 }) } };
		expect(await clearOverlay(recorded, owner, { cleared: [{ path: "/workspace/a.md", revision: 2 }], conflicts: [] })).toEqual({ remaining: 1 });
		expect(await clearOverlay(recorded, owner, { cleared: [{ path: "/workspace/a.md", revision: 1 }], conflicts: [] })).toEqual({ remaining: 0 });
	});

	it("stores a reported conflict on the matching revision only", async () => {
		const { deps } = await sealedWithEntries();
		await clearOverlay(deps, owner, { cleared: [], conflicts: [{ path: "/workspace/a.md", revision: 9, disk_sha256: null }] });
		expect((await readOverlayState(deps, location)).index.entries[0]?.conflict).toBeNull();
		await clearOverlay(deps, owner, { cleared: [], conflicts: [{ path: "/workspace/a.md", revision: 1, disk_sha256: hashOfText("disk") }] });
		expect((await readOverlayState(deps, location)).index.entries[0]?.conflict).toMatchObject({ reason: "changed", disk_sha256: hashOfText("disk") });
	});

	it("keeps the seal while it clears", async () => {
		const { deps } = await sealedWithEntries();
		const recorded = { ...deps, store: { ...deps.store, getComputer: async () => computer({ snapshotGeneration: 1 }) } };
		await clearOverlay(recorded, owner, { cleared: [{ path: "/workspace/a.md", revision: 1 }], conflicts: [] });
		expect((await readOverlayState(deps, location)).index.sealed?.owner_id).toBe("owner-1");
	});
});

describe("discarding", () => {
	it("refuses a revision that is not the entry's and leaves the entry", async () => {
		const { deps } = make();
		await create(deps, "mia", "/workspace/a.md", "a");
		const refusal = await refusalOf(() => discardOverlayEntry(deps, { tenantId: "anthus", userId: "ryan", path: "/workspace/a.md", revision: 2 }));
		expect(refusal.code).toBe("precondition_failed");
		expect((await readOverlayState(deps, location)).index.entries).toHaveLength(1);
	});

	it("is refused while the overlay is sealed", async () => {
		const { deps } = make();
		await create(deps, "mia", "/workspace/a.md", "a");
		await sealOverlay(deps, owner);
		const refusal = await refusalOf(() => discardOverlayEntry(deps, { tenantId: "anthus", userId: "ryan", path: "/workspace/a.md", revision: 1 }));
		expect(refusal.code).toBe("computer_starting");
	});
});
