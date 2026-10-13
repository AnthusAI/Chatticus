import { describe, expect, it } from "vitest";
import { symlinkHashOf, treeHashOf } from "@chatticus/host-protocol/live-file-rules";
import { createHash } from "node:crypto";
import {
	createEffectiveView,
	overlayEntryStateOf,
	snapshotTreeHash,
	snapshotViewOfIndex,
	OverlayTreeTooLargeError,
} from "../src/snapshot/overlay-merge.ts";
import { loadedIndexOf } from "../src/snapshot/files.ts";
import { deleteDirectoryEntry, deleteFileEntry, hashOfText, mkdirEntry, moveDirectoryEntry, moveFileEntry, putEntry, snapshotOf } from "./overlay-fixtures.ts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const base = snapshotOf([
	{ path: "/workspace/notes.md", kind: "file", content: "first draft" },
	{ path: "/workspace/docs", kind: "directory" },
	{ path: "/workspace/docs/a.txt", kind: "file", content: "aaa" },
	{ path: "/workspace/docs/deep", kind: "directory" },
	{ path: "/workspace/docs/deep/b.txt", kind: "file", content: "bb" },
	{ path: "/workspace/alias", kind: "symlink", target: "notes.md" },
]);

describe("the state of an entry against the snapshot", () => {
	const docsTree = snapshotTreeHash(base, "/workspace/docs");
	const table: ReadonlyArray<[string, Parameters<typeof overlayEntryStateOf>[0], "pending" | "applied" | "conflict"]> = [
		["put over its base", putEntry("/workspace/notes.md", "second", hashOfText("first draft")), "pending"],
		["put whose result the snapshot already holds", putEntry("/workspace/notes.md", "first draft", hashOfText("older")), "applied"],
		["put whose snapshot is neither base nor result", putEntry("/workspace/notes.md", "second", hashOfText("older")), "conflict"],
		["create where nothing exists", putEntry("/workspace/new.md", "x", null), "pending"],
		["create where a file appeared", putEntry("/workspace/notes.md", "x", null), "conflict"],
		["put with a stored conflict", { ...putEntry("/workspace/notes.md", "second", hashOfText("first draft")), conflict: { reason: "changed", disk_sha256: null, found_at: "2026-10-12T10:00:00.000Z" } }, "conflict"],
		["put with a stored conflict whose result is already in the snapshot", { ...putEntry("/workspace/notes.md", "first draft", hashOfText("older")), conflict: { reason: "changed", disk_sha256: null, found_at: "2026-10-12T10:00:00.000Z" } }, "applied"],
		["put with a source that changed", putEntry("/workspace/new.md", "x", null, { from: "/workspace/notes.md", from_sha256: hashOfText("other") }), "conflict"],
		["put with a source that is as seen", putEntry("/workspace/new.md", "x", null, { from: "/workspace/notes.md", from_sha256: hashOfText("first draft") }), "pending"],
		["delete of a file with its seen hash", deleteFileEntry("/workspace/notes.md", hashOfText("first draft")), "pending"],
		["delete of a file with another hash", deleteFileEntry("/workspace/notes.md", hashOfText("other")), "conflict"],
		["delete of a file already gone", deleteFileEntry("/workspace/gone.md", hashOfText("x")), "applied"],
		["delete of a symlink with its seen hash", deleteFileEntry("/workspace/alias", symlinkHashOf("notes.md", sha)), "pending"],
		["delete of an empty directory that has children", deleteDirectoryEntry("/workspace/docs", false, null), "conflict"],
		["delete of a directory that is gone", deleteDirectoryEntry("/workspace/old", false, null), "applied"],
		["recursive delete with its tree hash", deleteDirectoryEntry("/workspace/docs", true, docsTree), "pending"],
		["recursive delete with another tree hash", deleteDirectoryEntry("/workspace/docs", true, hashOfText("x")), "conflict"],
		["delete of a directory where a file exists", deleteDirectoryEntry("/workspace/notes.md", true, docsTree), "conflict"],
		["mkdir where nothing exists", mkdirEntry("/workspace/new"), "pending"],
		["mkdir where the directory exists", mkdirEntry("/workspace/docs"), "applied"],
		["mkdir where a file exists", mkdirEntry("/workspace/notes.md"), "conflict"],
		["file move from its source", moveFileEntry("/workspace/notes.md", "/workspace/renamed.md", "first draft"), "pending"],
		["file move already done", moveFileEntry("/workspace/gone.md", "/workspace/notes.md", "first draft"), "applied"],
		["file move whose source changed", moveFileEntry("/workspace/notes.md", "/workspace/renamed.md", "other"), "conflict"],
		["file move onto an existing path", moveFileEntry("/workspace/notes.md", "/workspace/docs/a.txt", "first draft"), "conflict"],
		["directory move from its source", moveDirectoryEntry("/workspace/docs", "/workspace/papers", docsTree), "pending"],
		["directory move whose tree changed", moveDirectoryEntry("/workspace/docs", "/workspace/papers", hashOfText("x")), "conflict"],
		["directory move onto an existing path", moveDirectoryEntry("/workspace/docs", "/workspace/docs/deep", docsTree), "conflict"],
	];
	it.each(table)("%s", (_name, entry, expected) => {
		expect(overlayEntryStateOf(entry, base)).toBe(expected);
	});

	it("takes a move of a directory as applied when the target holds its tree and the source is gone", () => {
		const moved = snapshotOf([
			{ path: "/workspace/papers", kind: "directory" },
			{ path: "/workspace/papers/a.txt", kind: "file", content: "aaa" },
		]);
		const entry = moveDirectoryEntry("/workspace/docs", "/workspace/papers", treeHashOf([{ relativePath: "a.txt", kind: "file", size: 3 }], sha));
		expect(overlayEntryStateOf(entry, moved)).toBe("applied");
	});
});

describe("the effective view", () => {
	it("shows a pending put in place of the snapshot file, from its blob", () => {
		const view = createEffectiveView(base, [putEntry("/workspace/notes.md", "second draft", hashOfText("first draft"))]);
		const node = view.lookup("/workspace/notes.md");
		expect(node?.sha256).toBe(hashOfText("second draft"));
		expect(node?.overlay).toBe("pending");
		expect(node?.source).toEqual({ type: "blob", sha256: hashOfText("second draft") });
	});

	it("shows the snapshot, marked, for an entry in conflict and keeps the person's hash", () => {
		const view = createEffectiveView(base, [putEntry("/workspace/notes.md", "mine", hashOfText("older"))]);
		const node = view.lookup("/workspace/notes.md");
		expect(node?.sha256).toBe(hashOfText("first draft"));
		expect(node?.overlay).toBe("conflict");
		expect(node?.mineSha256).toBe(hashOfText("mine"));
	});

	it("shows the snapshot unmarked for an entry the snapshot already holds", () => {
		const view = createEffectiveView(base, [putEntry("/workspace/notes.md", "first draft", hashOfText("older"))]);
		expect(view.lookup("/workspace/notes.md")?.overlay).toBe("none");
	});

	it("hides a deleted file and everything under a deleted directory", () => {
		const view = createEffectiveView(base, [
			deleteFileEntry("/workspace/notes.md", hashOfText("first draft")),
			deleteDirectoryEntry("/workspace/docs", true, snapshotTreeHash(base, "/workspace/docs")),
		]);
		expect(view.lookup("/workspace/notes.md")).toBeUndefined();
		expect(view.lookup("/workspace/docs")).toBeUndefined();
		expect(view.lookup("/workspace/docs/deep/b.txt")).toBeUndefined();
		expect(view.list("/workspace").entries.map((entry) => entry.name)).toEqual(["alias"]);
	});

	it("shows a moved file at its new path with the kept hash, read from the source, and hides the source", () => {
		const view = createEffectiveView(base, [moveFileEntry("/workspace/notes.md", "/workspace/renamed.md", "first draft")]);
		const node = view.lookup("/workspace/renamed.md");
		expect(node?.sha256).toBe(hashOfText("first draft"));
		expect(node?.source).toEqual({ type: "snapshot", path: "/workspace/notes.md" });
		expect(node?.overlay).toBe("pending");
		expect(view.lookup("/workspace/notes.md")).toBeUndefined();
	});

	it("translates paths under a moved directory to the snapshot paths", () => {
		const view = createEffectiveView(base, [moveDirectoryEntry("/workspace/docs", "/workspace/papers", snapshotTreeHash(base, "/workspace/docs"))]);
		expect(view.lookup("/workspace/docs")).toBeUndefined();
		expect(view.lookup("/workspace/docs/a.txt")).toBeUndefined();
		expect(view.lookup("/workspace/papers")?.overlay).toBe("pending");
		const nested = view.lookup("/workspace/papers/deep/b.txt");
		expect(nested?.sha256).toBe(hashOfText("bb"));
		expect(nested?.source).toEqual({ type: "snapshot", path: "/workspace/docs/deep/b.txt" });
		expect(view.list("/workspace/papers").entries.map((entry) => `${entry.path}:${entry.kind}`)).toEqual([
			"/workspace/papers/deep:directory",
			"/workspace/papers/a.txt:file",
		]);
		expect(view.list("/workspace/papers/deep").entries.map((entry) => entry.path)).toEqual(["/workspace/papers/deep/b.txt"]);
	});

	it("shows a made directory with the children the snapshot has under it, none when it does not exist", () => {
		const view = createEffectiveView(base, [mkdirEntry("/workspace/fresh"), putEntry("/workspace/fresh/x.md", "x", null)]);
		expect(view.lookup("/workspace/fresh")?.kind).toBe("directory");
		expect(view.list("/workspace/fresh").entries.map((entry) => entry.name)).toEqual(["x.md"]);
	});

	it("lists new files with the snapshot's children, directories first, then by name", () => {
		const view = createEffectiveView(base, [putEntry("/workspace/aaa.md", "x", null), mkdirEntry("/workspace/zzz")]);
		expect(view.list("/workspace").entries.map((entry) => `${entry.kind}:${entry.name}`)).toEqual([
			"directory:docs",
			"directory:zzz",
			"file:aaa.md",
			"symlink:alias",
			"file:notes.md",
		]);
	});

	it("cuts a listing at the cap and says so", () => {
		const many = createEffectiveView(base, [putEntry("/workspace/a.md", "x", null), putEntry("/workspace/b.md", "x", null)]);
		const cut = many.list("/workspace", 3);
		expect(cut.entries).toHaveLength(3);
		expect(cut.truncated).toBe(true);
	});

	it("replaces a snapshot child by the pending put of the same name, once", () => {
		const view = createEffectiveView(base, [putEntry("/workspace/notes.md", "second", hashOfText("first draft"))]);
		const names = view.list("/workspace").entries.filter((entry) => entry.name === "notes.md");
		expect(names).toHaveLength(1);
		expect(names[0]?.sha256).toBe(hashOfText("second"));
	});

	it("serves an empty workspace and the overlay when nothing was published", () => {
		const empty = snapshotViewOfIndex(null);
		const view = createEffectiveView(empty, [putEntry("/workspace/first.md", "hello", null)]);
		expect(view.lookup("/workspace")?.kind).toBe("directory");
		expect(view.list("/workspace").entries.map((entry) => entry.name)).toEqual(["first.md"]);
		expect(createEffectiveView(empty, []).list("/workspace").entries).toEqual([]);
	});

	it("builds the snapshot view of a loaded index", () => {
		const loaded = loadedIndexOf([
			{ path: "workspace", kind: "directory", size: 0, mode: 0o755, mtime_ms: 5, sha256: null, link_target: null, offset: null, length: null },
			{ path: "workspace/a.txt", kind: "file", size: 1, mode: 0o644, mtime_ms: 5, sha256: hashOfText("a"), link_target: null, offset: 0, length: 10 },
		]);
		const view = snapshotViewOfIndex(loaded);
		expect(view.get("/workspace/a.txt")?.sha256).toBe(hashOfText("a"));
		expect(view.children("/workspace").map((node) => node.path)).toEqual(["/workspace/a.txt"]);
	});
});

describe("effective hashes", () => {
	it("is a file's content hash", () => {
		expect(createEffectiveView(base, []).hashOf("/workspace/notes.md")).toBe(hashOfText("first draft"));
	});

	it("is the hash of 'symlink', a NUL byte and the target for a link", () => {
		expect(createEffectiveView(base, []).hashOf("/workspace/alias")).toBe(hashOfText("symlink\u0000notes.md"));
	});

	it("is the hash of nothing for an empty directory", () => {
		const view = createEffectiveView(base, [mkdirEntry("/workspace/empty")]);
		expect(view.hashOf("/workspace/empty")).toBe(hashOfText(""));
	});

	it("hashes a directory over its sorted descendants as kind, path and value lines", () => {
		const expected = hashOfText(
			["file\u0000a.txt\u00003\n", "dir\u0000deep\u00000\n", "file\u0000deep/b.txt\u00002\n"].join(""),
		);
		expect(createEffectiveView(base, []).hashOf("/workspace/docs")).toBe(expected);
	});

	it("sees a pending put in the tree hash of its directory", () => {
		const before = createEffectiveView(base, []).hashOf("/workspace/docs");
		const after = createEffectiveView(base, [putEntry("/workspace/docs/c.txt", "cccc", null)]).hashOf("/workspace/docs");
		expect(after).not.toBe(before);
	});

	it("is the tree hash of the re-rooted directory for a pending directory move", () => {
		const view = createEffectiveView(base, [moveDirectoryEntry("/workspace/docs", "/workspace/papers", snapshotTreeHash(base, "/workspace/docs"))]);
		expect(view.hashOf("/workspace/papers")).toBe(snapshotTreeHash(base, "/workspace/docs"));
	});

	it("is absent for a missing path", () => {
		expect(createEffectiveView(base, []).hashOf("/workspace/nothing")).toBeNull();
	});

	it("refuses a tree hash over 5000 descendants", () => {
		const files = Array.from({ length: 5001 }, (_unused, number) => ({ path: `/workspace/big/f${number}.txt`, kind: "file" as const, content: "x" }));
		const big = snapshotOf([{ path: "/workspace/big", kind: "directory" }, ...files]);
		expect(() => createEffectiveView(big, []).hashOf("/workspace/big")).toThrow(OverlayTreeTooLargeError);
		expect(() => snapshotTreeHash(big, "/workspace/big")).toThrow(OverlayTreeTooLargeError);
	});
});
