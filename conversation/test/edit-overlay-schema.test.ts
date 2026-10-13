import { describe, expect, it } from "vitest";
import {
	OVERLAY_INDEX_OBJECT,
	OVERLAY_MAX_ENTRIES,
	OVERLAY_MAX_TOTAL_BYTES,
	overlayBlobObject,
	overlayConflictSchema,
	overlayEntrySchema,
	overlayIndexSchema,
	overlaySealSchema,
	ownerOverlayAppliedRequestSchema,
	ownerOverlayAppliedResponseSchema,
	ownerOverlaySealRequestSchema,
	ownerOverlaySealResponseSchema,
} from "@chatticus/host-protocol/edit-overlay";

const hash = "a".repeat(64);
const otherHash = "b".repeat(64);
const now = "2026-10-12T11:00:00.000Z";

const common = { edited_by: "user-1", edited_at: now, revision: 1, conflict: null };

function putEntry(path: string, size = 10): Record<string, unknown> {
	return { ...common, op: "put", path, sha256: hash, size, mode: "644", base_sha256: null, from: null, from_sha256: null };
}

function deleteEntry(path: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { ...common, op: "delete", path, directory: false, recursive: false, base_sha256: hash, tree_sha256: null, ...overrides };
}

function mkdirEntry(path: string): Record<string, unknown> {
	return { ...common, op: "mkdir", path, mode: "775" };
}

function moveEntry(path: string, from: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { ...common, op: "move", path, from, directory: false, sha256: hash, tree_sha256: null, size: 100, mode: "644", ...overrides };
}

function indexOf(entries: unknown[], sealed: unknown = null): unknown {
	return { version: 1, sealed, entries };
}

describe("overlay entries", () => {
	it("parses each of the four kinds", () => {
		expect(overlayEntrySchema.safeParse(putEntry("/workspace/a.txt")).success).toBe(true);
		expect(overlayEntrySchema.safeParse(deleteEntry("/workspace/a.txt")).success).toBe(true);
		expect(overlayEntrySchema.safeParse(deleteEntry("/workspace/d", { directory: true, recursive: true, base_sha256: null, tree_sha256: otherHash })).success).toBe(true);
		expect(overlayEntrySchema.safeParse(mkdirEntry("/workspace/new")).success).toBe(true);
		expect(overlayEntrySchema.safeParse(moveEntry("/workspace/b.txt", "/workspace/a.txt")).success).toBe(true);
		expect(overlayEntrySchema.safeParse(moveEntry("/workspace/e", "/workspace/d", { directory: true, sha256: null, tree_sha256: otherHash })).success).toBe(true);
	});

	it("parses a put that was renamed from another file", () => {
		const renamed = { ...putEntry("/workspace/b.txt"), from: "/workspace/a.txt", from_sha256: otherHash };
		expect(overlayEntrySchema.safeParse(renamed).success).toBe(true);
	});

	it("refuses a path outside the workspace in a path or in a source", () => {
		expect(overlayEntrySchema.safeParse(putEntry("/etc/passwd")).success).toBe(false);
		expect(overlayEntrySchema.safeParse(putEntry("/workspace/../etc")).success).toBe(false);
		expect(overlayEntrySchema.safeParse(mkdirEntry("relative")).success).toBe(false);
		expect(overlayEntrySchema.safeParse(moveEntry("/workspace/b", "/etc/a")).success).toBe(false);
		expect(overlayEntrySchema.safeParse({ ...putEntry("/workspace/b"), from: "/tmp/a", from_sha256: hash }).success).toBe(false);
	});

	it("refuses an unknown op, an unknown field and a put larger than 256 KiB", () => {
		expect(overlayEntrySchema.safeParse({ ...putEntry("/workspace/a"), op: "chmod" }).success).toBe(false);
		expect(overlayEntrySchema.safeParse({ ...putEntry("/workspace/a"), extra: 1 }).success).toBe(false);
		expect(overlayEntrySchema.safeParse(putEntry("/workspace/a", 262144)).success).toBe(true);
		expect(overlayEntrySchema.safeParse(putEntry("/workspace/a", 262145)).success).toBe(false);
	});

	it("refuses a revision that is not positive", () => {
		expect(overlayEntrySchema.safeParse({ ...putEntry("/workspace/a"), revision: 0 }).success).toBe(false);
	});
});

describe("overlay conflicts", () => {
	it("parses every reason and refuses another", () => {
		for (const reason of ["changed", "collision", "not_empty", "kind_mismatch"]) {
			expect(overlayConflictSchema.safeParse({ reason, disk_sha256: null, found_at: now }).success).toBe(true);
			expect(overlayEntrySchema.safeParse({ ...putEntry("/workspace/a"), conflict: { reason, disk_sha256: hash, found_at: now } }).success).toBe(true);
		}
		expect(overlayConflictSchema.safeParse({ reason: "bored", disk_sha256: null, found_at: now }).success).toBe(false);
		expect(overlayConflictSchema.safeParse({ disk_sha256: null, found_at: now }).success).toBe(false);
	});
});

describe("overlay index", () => {
	it("parses an empty index and an index with a seal", () => {
		const seal = { owner_id: "owner-1", generation: 2, sealed_at: now, snapshot_generation: 0 };
		expect(overlayIndexSchema.safeParse(indexOf([])).success).toBe(true);
		const sealed = overlayIndexSchema.safeParse(indexOf([putEntry("/workspace/a")], seal));
		expect(sealed.success).toBe(true);
		expect(overlaySealSchema.safeParse(seal).success).toBe(true);
		expect(overlaySealSchema.safeParse({ ...seal, snapshot_generation: -1 }).success).toBe(false);
		expect(overlaySealSchema.safeParse({ owner_id: "owner-1", generation: 2, sealed_at: now }).success).toBe(false);
	});

	it("refuses a wrong version and an unknown field", () => {
		expect(overlayIndexSchema.safeParse({ version: 2, sealed: null, entries: [] }).success).toBe(false);
		expect(overlayIndexSchema.safeParse({ version: 1, sealed: null, entries: [], extra: 1 }).success).toBe(false);
	});

	it("accepts 100 entries of any kind and refuses a 101st", () => {
		const hundred = Array.from({ length: OVERLAY_MAX_ENTRIES }, (_, number) => mkdirEntry(`/workspace/d${number}`));
		expect(overlayIndexSchema.safeParse(indexOf(hundred)).success).toBe(true);
		expect(overlayIndexSchema.safeParse(indexOf([...hundred, mkdirEntry("/workspace/one-more")])).success).toBe(false);
	});

	it("refuses two entries at one path", () => {
		expect(overlayIndexSchema.safeParse(indexOf([putEntry("/workspace/a"), deleteEntry("/workspace/a")])).success).toBe(false);
	});

	it("refuses a source moved twice", () => {
		const twice = indexOf([moveEntry("/workspace/b", "/workspace/a"), moveEntry("/workspace/c", "/workspace/a")]);
		expect(overlayIndexSchema.safeParse(twice).success).toBe(false);
		const putAndMove = indexOf([moveEntry("/workspace/b", "/workspace/a"), { ...putEntry("/workspace/c"), from: "/workspace/a", from_sha256: hash }]);
		expect(overlayIndexSchema.safeParse(putAndMove).success).toBe(false);
	});

	it("refuses a source that is also an entry", () => {
		expect(overlayIndexSchema.safeParse(indexOf([moveEntry("/workspace/b", "/workspace/a"), putEntry("/workspace/a")])).success).toBe(false);
		expect(overlayIndexSchema.safeParse(indexOf([moveEntry("/workspace/b", "/workspace/a"), deleteEntry("/workspace/a")])).success).toBe(false);
		expect(overlayIndexSchema.safeParse(indexOf([moveEntry("/workspace/b", "/workspace/a")])).success).toBe(true);
	});

	it("counts only put content toward 8 MiB", () => {
		const full = OVERLAY_MAX_TOTAL_BYTES / 262144;
		const puts = Array.from({ length: full }, (_, number) => putEntry(`/workspace/p${number}`, 262144));
		expect(overlayIndexSchema.safeParse(indexOf(puts)).success).toBe(true);
		expect(overlayIndexSchema.safeParse(indexOf([...puts, putEntry("/workspace/one-byte", 1)])).success).toBe(false);
	});

	it("adds no content bytes for deletes, moves and mkdirs", () => {
		const puts = Array.from({ length: OVERLAY_MAX_TOTAL_BYTES / 262144 }, (_, number) => putEntry(`/workspace/p${number}`, 262144));
		const others = [
			deleteEntry("/workspace/x"),
			mkdirEntry("/workspace/y"),
			moveEntry("/workspace/m2", "/workspace/m1", { size: 40 * 1024 * 1024 }),
		];
		expect(overlayIndexSchema.safeParse(indexOf([...puts, ...others])).success).toBe(true);
	});
});

describe("overlay owner routes and objects", () => {
	it("names the index object and the blob objects", () => {
		expect(OVERLAY_INDEX_OBJECT).toBe("overlay/index.json");
		expect(overlayBlobObject(hash)).toBe(`overlay/blobs/${hash}`);
	});

	it("parses the seal request and response", () => {
		expect(ownerOverlaySealRequestSchema.safeParse({ owner_id: "o", generation: 1 }).success).toBe(true);
		expect(ownerOverlaySealRequestSchema.safeParse({ owner_id: "o", generation: 1, extra: 1 }).success).toBe(false);
		expect(ownerOverlaySealResponseSchema.safeParse({ entries: [putEntry("/workspace/a"), mkdirEntry("/workspace/d")] }).success).toBe(true);
		const tooMany = Array.from({ length: OVERLAY_MAX_ENTRIES + 1 }, (_, number) => mkdirEntry(`/workspace/d${number}`));
		expect(ownerOverlaySealResponseSchema.safeParse({ entries: tooMany }).success).toBe(false);
	});

	it("defaults cleared and conflicts to empty", () => {
		const parsed = ownerOverlayAppliedRequestSchema.parse({ owner_id: "o", generation: 1 });
		expect(parsed.cleared).toEqual([]);
		expect(parsed.conflicts).toEqual([]);
	});

	it("parses cleared and conflicting entries by path and revision", () => {
		const parsed = ownerOverlayAppliedRequestSchema.parse({
			owner_id: "o",
			generation: 1,
			cleared: [{ path: "/workspace/a", revision: 2 }],
			conflicts: [{ path: "/workspace/b", revision: 3, reason: "not_empty", disk_sha256: otherHash }],
		});
		expect(parsed.cleared).toHaveLength(1);
		expect(parsed.conflicts[0]?.disk_sha256).toBe(otherHash);
		expect(parsed.conflicts[0]?.reason).toBe("not_empty");
	});

	it("refuses a reported conflict without a reason or with an unknown one", () => {
		const base = { owner_id: "o", generation: 1, cleared: [] };
		expect(ownerOverlayAppliedRequestSchema.safeParse({ ...base, conflicts: [{ path: "/workspace/b", revision: 3, disk_sha256: null }] }).success).toBe(false);
		expect(
			ownerOverlayAppliedRequestSchema.safeParse({ ...base, conflicts: [{ path: "/workspace/b", revision: 3, reason: "whim", disk_sha256: null }] }).success,
		).toBe(false);
	});

	it("refuses a reference without a revision, a path outside the workspace and an unknown field", () => {
		expect(ownerOverlayAppliedRequestSchema.safeParse({ owner_id: "o", generation: 1, cleared: [{ path: "/workspace/a" }] }).success).toBe(false);
		expect(ownerOverlayAppliedRequestSchema.safeParse({ owner_id: "o", generation: 1, cleared: [{ path: "/etc/a", revision: 1 }] }).success).toBe(false);
		expect(ownerOverlayAppliedRequestSchema.safeParse({ owner_id: "o", generation: 1, extra: 1 }).success).toBe(false);
	});

	it("parses the applied response", () => {
		expect(ownerOverlayAppliedResponseSchema.safeParse({ remaining: 0 }).success).toBe(true);
		expect(ownerOverlayAppliedResponseSchema.safeParse({ remaining: -1 }).success).toBe(false);
	});
});
