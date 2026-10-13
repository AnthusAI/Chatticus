import { describe, expect, it } from "vitest";
import type { OverlayEntry } from "@chatticus/host-protocol/edit-overlay";
import { planOverlayChange, type OverlayChangeRequest, type OverlayPlan } from "../src/domain/overlay-write-algebra.ts";
import { snapshotTreeHash } from "../src/snapshot/overlay-merge.ts";
import {
	deleteDirectoryEntry,
	deleteFileEntry,
	hashOfText,
	mkdirEntry,
	moveDirectoryEntry,
	moveFileEntry,
	putEntry,
	snapshotOf,
} from "./overlay-fixtures.ts";

const snapshot = snapshotOf([
	{ path: "/workspace/a.txt", kind: "file", content: "a" },
	{ path: "/workspace/b.txt", kind: "file", content: "b" },
	{ path: "/workspace/link", kind: "symlink", target: "a.txt" },
	{ path: "/workspace/docs", kind: "directory" },
	{ path: "/workspace/docs/one.txt", kind: "file", content: "one" },
	{ path: "/workspace/docs/two.txt", kind: "file", content: "two" },
	{ path: "/workspace/empty", kind: "directory" },
	{ path: "/workspace/other", kind: "directory" },
	{ path: "/workspace/other/x.txt", kind: "file", content: "x" },
]);

const hashA = hashOfText("a");
const hashB = hashOfText("b");
const docsTree = snapshotTreeHash(snapshot, "/workspace/docs");

function plan(entries: readonly OverlayEntry[], request: OverlayChangeRequest): OverlayPlan {
	return planOverlayChange({ snapshot, entries, request, editedBy: "ryan", editedAt: "2026-10-12T11:00:00.000Z" });
}

function entriesOf(result: OverlayPlan): readonly OverlayEntry[] {
	if (result.kind !== "changed") throw new Error(`Expected a change, got ${JSON.stringify(result)}`);
	return result.entries;
}

const putRequest = (path: string, content: string, ifMatch: string | null): OverlayChangeRequest => ({
	op: "put",
	path,
	sha256: hashOfText(content),
	size: Buffer.byteLength(content),
	precondition: ifMatch === null ? { type: "if_none_match" } : { type: "if_match", sha256: ifMatch },
});
const deleteRequest = (path: string, ifMatchSha256: string, recursive = false, ownerRole = false): OverlayChangeRequest => ({ op: "delete", path, recursive, ownerRole, ifMatchSha256 });
const moveRequest = (from: string, to: string, ifMatchSha256: string): OverlayChangeRequest => ({ op: "move", from, to, ifMatchSha256 });
const mkdirRequest = (path: string): OverlayChangeRequest => ({ op: "mkdir", path });

describe("the write algebra: put", () => {
	it("creates a file where nothing exists, with no base", () => {
		expect(entriesOf(plan([], putRequest("/workspace/new.md", "n", null)))).toMatchObject([
			{ op: "put", path: "/workspace/new.md", sha256: hashOfText("n"), base_sha256: null, from: null, revision: 1, edited_by: "ryan", conflict: null, mode: "664" },
		]);
	});

	it("replaces a snapshot file and keeps the snapshot hash as the base, and its mode", () => {
		expect(entriesOf(plan([], putRequest("/workspace/a.txt", "a2", hashA)))).toMatchObject([
			{ op: "put", path: "/workspace/a.txt", base_sha256: hashA, mode: "644", revision: 1 },
		]);
	});

	it("turns an earlier put into the next revision and keeps its first base and mode", () => {
		const earlier = putEntry("/workspace/a.txt", "a2", hashA, { mode: "600" });
		expect(entriesOf(plan([earlier], putRequest("/workspace/a.txt", "a3", hashOfText("a2"))))).toMatchObject([
			{ op: "put", path: "/workspace/a.txt", sha256: hashOfText("a3"), base_sha256: hashA, revision: 2, mode: "600" },
		]);
	});

	it("becomes a put over a delete of the file, based on the snapshot hash", () => {
		const result = plan([deleteFileEntry("/workspace/a.txt", hashA)], putRequest("/workspace/a.txt", "back", null));
		expect(entriesOf(result)).toMatchObject([{ op: "put", path: "/workspace/a.txt", base_sha256: hashA, revision: 2 }]);
	});

	it("turns the target of a move into a put that remembers its source and hides it", () => {
		const result = plan([moveFileEntry("/workspace/a.txt", "/workspace/moved.txt", "a")], putRequest("/workspace/moved.txt", "edited", hashA));
		expect(entriesOf(result)).toMatchObject([
			{ op: "put", path: "/workspace/moved.txt", from: "/workspace/a.txt", from_sha256: hashA, base_sha256: null, revision: 2 },
		]);
	});

	it("keeps the source of a put that already has one", () => {
		const earlier = putEntry("/workspace/moved.txt", "e1", null, { from: "/workspace/a.txt", from_sha256: hashA });
		expect(entriesOf(plan([earlier], putRequest("/workspace/moved.txt", "e2", hashOfText("e1"))))).toMatchObject([
			{ op: "put", from: "/workspace/a.txt", from_sha256: hashA, base_sha256: null, revision: 2 },
		]);
	});

	it("takes the snapshot's hash as the new base when the person overwrites an entry in conflict", () => {
		const conflicted = putEntry("/workspace/a.txt", "mine", hashOfText("older"));
		expect(entriesOf(plan([conflicted], putRequest("/workspace/a.txt", "again", hashA)))).toMatchObject([
			{ op: "put", base_sha256: hashA, from: null, revision: 2 },
		]);
	});

	it("takes the snapshot's hash as the new base over an entry the snapshot already holds", () => {
		const applied = putEntry("/workspace/a.txt", "a", hashOfText("older"));
		expect(entriesOf(plan([applied], putRequest("/workspace/a.txt", "next", hashA)))).toMatchObject([{ op: "put", base_sha256: hashA, revision: 2 }]);
	});

	it("is a no-op when the content equals the effective hash", () => {
		expect(plan([], putRequest("/workspace/a.txt", "a", hashA))).toMatchObject({ kind: "unchanged" });
	});

	it("is not a no-op for an entry in conflict, so the person can settle it by writing theirs", () => {
		const conflicted = putEntry("/workspace/a.txt", "mine", hashOfText("older"));
		expect(plan([conflicted], putRequest("/workspace/a.txt", "a", hashA)).kind).toBe("changed");
	});

	const refusals: ReadonlyArray<[string, readonly OverlayEntry[], OverlayChangeRequest, string]> = [
		["a stale If-Match", [], putRequest("/workspace/a.txt", "x", hashB), "precondition_failed"],
		["If-Match on a file that does not exist", [], putRequest("/workspace/none.txt", "x", hashA), "precondition_failed"],
		["If-None-Match on a file that exists", [], putRequest("/workspace/a.txt", "x", null), "already_exists"],
		["a path inside .git", [], putRequest("/workspace/.git/config", "x", null), "path_refused"],
		["a path in an excluded directory", [], putRequest("/workspace/app/node_modules/x.js", "x", null), "not_in_saved_copy"],
		["a link", [], putRequest("/workspace/link", "x", hashOfText("symlink\u0000a.txt")), "path_refused"],
		["a path through a link", [], putRequest("/workspace/link/x", "x", null), "path_refused"],
		["a directory", [], putRequest("/workspace/docs", "x", docsTree), "not_a_file"],
		["a missing parent", [], putRequest("/workspace/missing/new.md", "x", null), "parent_missing"],
		["a file as the parent", [], putRequest("/workspace/a.txt/new.md", "x", null), "not_a_directory"],
		["the workspace root", [], putRequest("/workspace", "x", null), "path_refused"],
		[
			"a path under a pending folder rename",
			[moveDirectoryEntry("/workspace/docs", "/workspace/papers", docsTree)],
			putRequest("/workspace/papers/one.txt", "x", hashOfText("one")),
			"path_busy",
		],
		[
			"the old path of a pending folder rename",
			[moveDirectoryEntry("/workspace/docs", "/workspace/papers", docsTree)],
			putRequest("/workspace/docs/new.txt", "x", null),
			"path_busy",
		],
		[
			"the source of a pending file rename",
			[moveFileEntry("/workspace/a.txt", "/workspace/moved.txt", "a")],
			putRequest("/workspace/a.txt", "x", null),
			"path_busy",
		],
		[
			"a pending delete of a folder",
			[deleteDirectoryEntry("/workspace/empty", false, null)],
			putRequest("/workspace/empty", "x", null),
			"path_busy",
		],
	];
	it.each(refusals)("refuses %s", (_name, entries, request, code) => {
		expect(plan(entries, request)).toMatchObject({ kind: "refused", code });
	});

	it("carries the current hash on a failed precondition", () => {
		expect(plan([], putRequest("/workspace/a.txt", "x", hashB))).toMatchObject({ kind: "refused", currentSha256: hashA });
	});

	it("carries the snapshot's hash for a path whose entry is in conflict", () => {
		const conflicted = putEntry("/workspace/a.txt", "mine", hashOfText("older"));
		expect(plan([conflicted], putRequest("/workspace/a.txt", "x", hashOfText("mine")))).toMatchObject({ kind: "refused", currentSha256: hashA });
	});

	it("refuses content over 256 KiB", () => {
		const large: OverlayChangeRequest = { op: "put", path: "/workspace/new.md", sha256: hashB, size: 262145, precondition: { type: "if_none_match" } };
		expect(plan([], large)).toMatchObject({ kind: "refused", code: "file_too_large" });
	});
});

describe("the write algebra: the caps", () => {
	const hundred = Array.from({ length: 100 }, (_unused, number) => putEntry(`/workspace/f${number}.md`, "x", null));

	it("refuses a hundred and first entry of any kind", () => {
		expect(plan(hundred, putRequest("/workspace/one-too-many.md", "x", null))).toMatchObject({ kind: "refused", code: "overlay_full" });
		expect(plan(hundred, mkdirRequest("/workspace/one-too-many"))).toMatchObject({ kind: "refused", code: "overlay_full" });
		expect(plan(hundred, deleteRequest("/workspace/a.txt", hashA))).toMatchObject({ kind: "refused", code: "overlay_full" });
		expect(plan(hundred, moveRequest("/workspace/a.txt", "/workspace/z.txt", hashA))).toMatchObject({ kind: "refused", code: "overlay_full" });
	});

	it("still accepts another edit of a path that already has an entry", () => {
		expect(plan(hundred, putRequest("/workspace/f0.md", "y", hashOfText("x"))).kind).toBe("changed");
	});

	it("refuses content past 8 MiB in total, and counts only puts", () => {
		const big = putEntry("/workspace/big.bin", "x", null, { size: 8388608 });
		expect(plan([big], putRequest("/workspace/more.md", "y", null))).toMatchObject({ kind: "refused", code: "overlay_full" });
		expect(plan([big], mkdirRequest("/workspace/folder")).kind).toBe("changed");
	});
});

describe("the write algebra: delete", () => {
	it("records a delete of a snapshot file with its hash as the base", () => {
		expect(entriesOf(plan([], deleteRequest("/workspace/a.txt", hashA)))).toMatchObject([
			{ op: "delete", path: "/workspace/a.txt", directory: false, recursive: false, base_sha256: hashA, tree_sha256: null },
		]);
	});

	it("records a delete of a symlink with its link hash, not the target's", () => {
		const linkHash = hashOfText("symlink\u0000a.txt");
		expect(entriesOf(plan([], deleteRequest("/workspace/link", linkHash)))).toMatchObject([{ op: "delete", path: "/workspace/link", base_sha256: linkHash }]);
	});

	it("removes a pending create so nothing is left to apply", () => {
		const created = putEntry("/workspace/new.md", "n", null);
		expect(entriesOf(plan([created], deleteRequest("/workspace/new.md", hashOfText("n"))))).toEqual([]);
	});

	it("turns a pending replace into a delete with the original base", () => {
		const replaced = putEntry("/workspace/a.txt", "a2", hashA);
		expect(entriesOf(plan([replaced], deleteRequest("/workspace/a.txt", hashOfText("a2"))))).toMatchObject([
			{ op: "delete", path: "/workspace/a.txt", base_sha256: hashA, revision: 2 },
		]);
	});

	it("turns a put that came from a rename into a delete of its source", () => {
		const renamed = putEntry("/workspace/moved.txt", "e", null, { from: "/workspace/a.txt", from_sha256: hashA });
		expect(entriesOf(plan([renamed], deleteRequest("/workspace/moved.txt", hashOfText("e"))))).toMatchObject([
			{ op: "delete", path: "/workspace/a.txt", base_sha256: hashA },
		]);
	});

	it("turns the target of a move into a delete of its source with the kept hash", () => {
		const moved = moveFileEntry("/workspace/a.txt", "/workspace/moved.txt", "a");
		expect(entriesOf(plan([moved], deleteRequest("/workspace/moved.txt", hashA)))).toMatchObject([
			{ op: "delete", path: "/workspace/a.txt", base_sha256: hashA },
		]);
	});

	it("replaces an entry in conflict by a delete based on the snapshot's hash", () => {
		const conflicted = putEntry("/workspace/a.txt", "mine", hashOfText("older"));
		expect(entriesOf(plan([conflicted], deleteRequest("/workspace/a.txt", hashA)))).toMatchObject([
			{ op: "delete", path: "/workspace/a.txt", base_sha256: hashA },
		]);
	});

	it("records a delete of an empty folder", () => {
		expect(entriesOf(plan([], deleteRequest("/workspace/empty", hashOfText(""))))).toMatchObject([
			{ op: "delete", path: "/workspace/empty", directory: true, recursive: false },
		]);
	});

	it("removes a pending mkdir instead of deleting it", () => {
		expect(entriesOf(plan([mkdirEntry("/workspace/fresh")], deleteRequest("/workspace/fresh", hashOfText(""))))).toEqual([]);
	});

	it("refuses a folder that is not empty without recursive", () => {
		expect(plan([], deleteRequest("/workspace/docs", docsTree))).toMatchObject({ kind: "refused", code: "directory_not_empty" });
	});

	it("refuses a recursive delete of a folder that is not empty to a member", () => {
		expect(plan([], deleteRequest("/workspace/docs", docsTree, true, false))).toMatchObject({ kind: "refused", code: "owner_role_required" });
	});

	it("lets a member delete a folder that only looks empty because its children are already deleted", () => {
		const entries = [deleteFileEntry("/workspace/docs/one.txt", hashOfText("one")), deleteFileEntry("/workspace/docs/two.txt", hashOfText("two"))];
		const result = plan(entries, deleteRequest("/workspace/docs", hashOfText("")));
		expect(entriesOf(result)).toMatchObject([{ op: "delete", path: "/workspace/docs", directory: true, recursive: true, tree_sha256: docsTree }]);
	});

	it("records a recursive delete with the snapshot's tree hash and drops every entry below it", () => {
		const below = putEntry("/workspace/docs/three.txt", "3", null);
		const effective = hashOfText(["file\u0000one.txt\u00003\n", "file\u0000three.txt\u00001\n", "file\u0000two.txt\u00003\n"].join(""));
		const result = plan([below, putEntry("/workspace/b.txt", "b2", hashB)], deleteRequest("/workspace/docs", effective, true, true));
		expect(entriesOf(result)).toMatchObject([
			{ op: "put", path: "/workspace/b.txt" },
			{ op: "delete", path: "/workspace/docs", directory: true, recursive: true, tree_sha256: docsTree },
		]);
		expect(result).toMatchObject({ removed: 4 });
	});

	it("turns a dropped rename target into a delete of its source outside the folder", () => {
		const intoDocs = moveFileEntry("/workspace/a.txt", "/workspace/docs/a.txt", "a");
		const effective = hashOfText(["file\u0000a.txt\u00001\n", "file\u0000one.txt\u00003\n", "file\u0000two.txt\u00003\n"].join(""));
		const result = plan([intoDocs], deleteRequest("/workspace/docs", effective, true, true));
		expect(entriesOf(result)).toMatchObject([
			{ op: "delete", path: "/workspace/a.txt", base_sha256: hashA },
			{ op: "delete", path: "/workspace/docs", recursive: true },
		]);
	});

	it("does not delete a source that lies inside the folder being removed", () => {
		const within = moveFileEntry("/workspace/docs/one.txt", "/workspace/docs/uno.txt", "one");
		const effective = hashOfText(["file\u0000two.txt\u00003\n", "file\u0000uno.txt\u00003\n"].join(""));
		const result = plan([within], deleteRequest("/workspace/docs", effective, true, true));
		expect(entriesOf(result)).toMatchObject([{ op: "delete", path: "/workspace/docs", recursive: true }]);
		expect(entriesOf(result)).toHaveLength(1);
	});

	it("refuses to delete a folder while a file waits to be taken out of it", () => {
		const out = moveFileEntry("/workspace/docs/one.txt", "/workspace/uno.txt", "one");
		const effective = hashOfText("file\u0000two.txt\u00003\n");
		expect(plan([out], deleteRequest("/workspace/docs", effective, true, true))).toMatchObject({ kind: "refused", code: "path_busy" });
	});

	const refusals: ReadonlyArray<[string, readonly OverlayEntry[], OverlayChangeRequest, string]> = [
		["a missing path", [], deleteRequest("/workspace/none.txt", hashA), "not_found"],
		["a stale hash", [], deleteRequest("/workspace/a.txt", hashB), "precondition_failed"],
		["the workspace root", [], deleteRequest("/workspace", hashB, true, true), "path_refused"],
		["a path in .git", [], deleteRequest("/workspace/.git", hashB, true, true), "path_refused"],
		["a path in an excluded folder", [], deleteRequest("/workspace/x/node_modules/y", hashB), "not_in_saved_copy"],
		[
			"a path under a pending recursive delete",
			[deleteDirectoryEntry("/workspace/docs", true, docsTree)],
			deleteRequest("/workspace/docs/one.txt", hashOfText("one")),
			"path_busy",
		],
	];
	it.each(refusals)("refuses %s", (_name, entries, request, code) => {
		expect(plan(entries, request)).toMatchObject({ kind: "refused", code });
	});

	it("refuses with too_many_entries when a folder has more than 5000 descendants", () => {
		const files = Array.from({ length: 5001 }, (_unused, number) => ({ path: `/workspace/big/f${number}.txt`, kind: "file" as const, content: "x" }));
		const bigSnapshot = snapshotOf([{ path: "/workspace/big", kind: "directory" }, ...files]);
		const result = planOverlayChange({
			snapshot: bigSnapshot,
			entries: [],
			request: deleteRequest("/workspace/big", hashB, true, true),
			editedBy: "ryan",
			editedAt: "2026-10-12T11:00:00.000Z",
		});
		expect(result).toMatchObject({ kind: "refused", code: "too_many_entries" });
	});
});

describe("the write algebra: move", () => {
	it("records a rename of a snapshot file that keeps its hash, size and mode and carries no blob", () => {
		expect(entriesOf(plan([], moveRequest("/workspace/a.txt", "/workspace/z.txt", hashA)))).toMatchObject([
			{ op: "move", path: "/workspace/z.txt", from: "/workspace/a.txt", directory: false, sha256: hashA, size: 1, mode: "644" },
		]);
	});

	it("records a rename of a symlink with its link hash", () => {
		const linkHash = hashOfText("symlink\u0000a.txt");
		expect(entriesOf(plan([], moveRequest("/workspace/link", "/workspace/link2", linkHash)))).toMatchObject([
			{ op: "move", path: "/workspace/link2", from: "/workspace/link", sha256: linkHash },
		]);
	});

	it("records a rename of a folder with its tree hash", () => {
		expect(entriesOf(plan([], moveRequest("/workspace/docs", "/workspace/papers", docsTree)))).toMatchObject([
			{ op: "move", path: "/workspace/papers", from: "/workspace/docs", directory: true, sha256: null, tree_sha256: docsTree, mode: "755" },
		]);
	});

	it("changes the path of a pending create", () => {
		const created = putEntry("/workspace/new.md", "n", null);
		expect(entriesOf(plan([created], moveRequest("/workspace/new.md", "/workspace/newer.md", hashOfText("n"))))).toMatchObject([
			{ op: "put", path: "/workspace/newer.md", base_sha256: null, from: null, revision: 2 },
		]);
	});

	it("turns a renamed pending replace into a put with a source, using the same blob", () => {
		const replaced = putEntry("/workspace/a.txt", "a2", hashA);
		expect(entriesOf(plan([replaced], moveRequest("/workspace/a.txt", "/workspace/z.txt", hashOfText("a2"))))).toMatchObject([
			{ op: "put", path: "/workspace/z.txt", sha256: hashOfText("a2"), from: "/workspace/a.txt", from_sha256: hashA, base_sha256: null },
		]);
	});

	it("changes the path of a put that has a source, keeping the source", () => {
		const renamed = putEntry("/workspace/m1.txt", "e", null, { from: "/workspace/a.txt", from_sha256: hashA });
		expect(entriesOf(plan([renamed], moveRequest("/workspace/m1.txt", "/workspace/m2.txt", hashOfText("e"))))).toMatchObject([
			{ op: "put", path: "/workspace/m2.txt", from: "/workspace/a.txt", from_sha256: hashA },
		]);
	});

	it("changes the path of a move, keeping the source", () => {
		const moved = moveFileEntry("/workspace/a.txt", "/workspace/m1.txt", "a");
		expect(entriesOf(plan([moved], moveRequest("/workspace/m1.txt", "/workspace/m2.txt", hashA)))).toMatchObject([
			{ op: "move", path: "/workspace/m2.txt", from: "/workspace/a.txt" },
		]);
	});

	it("removes a move that renames a file back to its own path", () => {
		const moved = moveFileEntry("/workspace/a.txt", "/workspace/b2.txt", "a");
		expect(entriesOf(plan([moved], moveRequest("/workspace/b2.txt", "/workspace/a.txt", hashA)))).toEqual([]);
	});

	it("turns an edited rename moved back into a plain edit of the original path", () => {
		const renamed = putEntry("/workspace/m1.txt", "edited", null, { from: "/workspace/a.txt", from_sha256: hashA });
		expect(entriesOf(plan([renamed], moveRequest("/workspace/m1.txt", "/workspace/a.txt", hashOfText("edited"))))).toMatchObject([
			{ op: "put", path: "/workspace/a.txt", base_sha256: hashA, from: null, from_sha256: null },
		]);
	});

	it("removes an unedited rename moved back", () => {
		const renamed = putEntry("/workspace/m1.txt", "a", null, { from: "/workspace/a.txt", from_sha256: hashA });
		expect(entriesOf(plan([renamed], moveRequest("/workspace/m1.txt", "/workspace/a.txt", hashA)))).toEqual([]);
	});

	it("replaces a conflicted entry at the source by the move, since the person acted on theirs", () => {
		const conflicted = putEntry("/workspace/a.txt", "mine", hashOfText("older"));
		expect(entriesOf(plan([conflicted], moveRequest("/workspace/a.txt", "/workspace/z.txt", hashA)))).toMatchObject([
			{ op: "move", path: "/workspace/z.txt", from: "/workspace/a.txt" },
		]);
	});

	const refusals: ReadonlyArray<[string, readonly OverlayEntry[], OverlayChangeRequest, string]> = [
		["a missing source", [], moveRequest("/workspace/none.txt", "/workspace/z.txt", hashA), "not_found"],
		["a target that exists", [], moveRequest("/workspace/a.txt", "/workspace/b.txt", hashA), "already_exists"],
		["the same path", [], moveRequest("/workspace/a.txt", "/workspace/a.txt", hashA), "already_exists"],
		["a missing parent of the target", [], moveRequest("/workspace/a.txt", "/workspace/none/z.txt", hashA), "parent_missing"],
		["a stale hash", [], moveRequest("/workspace/a.txt", "/workspace/z.txt", hashB), "precondition_failed"],
		["a folder into its own subtree", [], moveRequest("/workspace/docs", "/workspace/docs/inner", docsTree), "invalid_move"],
		["the workspace root", [], moveRequest("/workspace", "/workspace/z", docsTree), "path_refused"],
		["a target in .git", [], moveRequest("/workspace/a.txt", "/workspace/.git/a", hashA), "path_refused"],
		["a target in an excluded folder", [], moveRequest("/workspace/a.txt", "/workspace/dist/a", hashA), "not_in_saved_copy"],
		["a target under a pending folder rename", [moveDirectoryEntry("/workspace/docs", "/workspace/papers", docsTree)], moveRequest("/workspace/a.txt", "/workspace/papers/a.txt", hashA), "path_busy"],
		["a folder that has a change inside", [putEntry("/workspace/docs/new.md", "n", null)], moveRequest("/workspace/docs", "/workspace/papers", hashOfText("file\u0000new.md\u00001\n" + "file\u0000one.txt\u00003\n" + "file\u0000two.txt\u00003\n")), "path_busy"],
		["a target with a change waiting", [deleteFileEntry("/workspace/b.txt", hashB)], moveRequest("/workspace/a.txt", "/workspace/b.txt", hashA), "path_busy"],
		["a target that is the source of another rename", [moveFileEntry("/workspace/b.txt", "/workspace/c.txt", "b")], moveRequest("/workspace/a.txt", "/workspace/b.txt", hashA), "path_busy"],
	];
	it.each(refusals)("refuses %s", (_name, entries, request, code) => {
		expect(plan(entries, request)).toMatchObject({ kind: "refused", code });
	});
});

describe("the write algebra: mkdir", () => {
	it("adds a pending folder with the folder mode", () => {
		expect(entriesOf(plan([], mkdirRequest("/workspace/fresh")))).toMatchObject([{ op: "mkdir", path: "/workspace/fresh", mode: "775", revision: 1 }]);
	});

	it("is a no-op for a folder that exists, a pending folder and the root", () => {
		expect(plan([], mkdirRequest("/workspace/docs"))).toMatchObject({ kind: "unchanged", created: false });
		expect(plan([mkdirEntry("/workspace/fresh")], mkdirRequest("/workspace/fresh"))).toMatchObject({ kind: "unchanged" });
		expect(plan([], mkdirRequest("/workspace"))).toMatchObject({ kind: "unchanged" });
	});

	it("is busy, not a no-op, for the target of a pending folder rename", () => {
		const renamed = [moveDirectoryEntry("/workspace/docs", "/workspace/papers", docsTree)];
		expect(plan(renamed, mkdirRequest("/workspace/papers"))).toMatchObject({ kind: "refused", code: "path_busy" });
	});

	it("may be made inside a pending folder", () => {
		expect(plan([mkdirEntry("/workspace/fresh")], mkdirRequest("/workspace/fresh/inner")).kind).toBe("changed");
	});

	const refusals: ReadonlyArray<[string, readonly OverlayEntry[], OverlayChangeRequest, string]> = [
		["a file at the path", [], mkdirRequest("/workspace/a.txt"), "already_exists"],
		["a link at the path", [], mkdirRequest("/workspace/link"), "already_exists"],
		["a missing parent", [], mkdirRequest("/workspace/none/inner"), "parent_missing"],
		["a path in .git", [], mkdirRequest("/workspace/.git/hooks"), "path_refused"],
		["a path in an excluded folder", [], mkdirRequest("/workspace/build"), "not_in_saved_copy"],
		["a pending delete of a folder at the path", [deleteDirectoryEntry("/workspace/empty", false, null)], mkdirRequest("/workspace/empty"), "path_busy"],
	];
	it.each(refusals)("refuses %s", (_name, entries, request, code) => {
		expect(plan(entries, request)).toMatchObject({ kind: "refused", code });
	});
});

describe("the write algebra: exclusivity of a pending folder rename or recursive delete", () => {
	const renamed = [moveDirectoryEntry("/workspace/docs", "/workspace/papers", docsTree)];
	const deleted = [deleteDirectoryEntry("/workspace/docs", true, docsTree)];
	const requests: ReadonlyArray<[string, OverlayChangeRequest]> = [
		["a put under the target", putRequest("/workspace/papers/new.md", "n", null)],
		["a put under the source", putRequest("/workspace/docs/new.md", "n", null)],
		["a delete under the target", deleteRequest("/workspace/papers/one.txt", hashOfText("one"))],
		["a rename onto the target", moveRequest("/workspace/a.txt", "/workspace/papers/a.txt", hashA)],
		["a rename out of the target", moveRequest("/workspace/papers/one.txt", "/workspace/one.txt", hashOfText("one"))],
		["a folder made under the target", mkdirRequest("/workspace/papers/new")],
	];
	it.each(requests)("refuses %s while the folder is waiting to be renamed", (_name, request) => {
		expect(plan(renamed, request)).toMatchObject({ kind: "refused", code: "path_busy" });
	});

	it("refuses a put under a folder waiting to be deleted", () => {
		expect(plan(deleted, putRequest("/workspace/docs/new.md", "n", null))).toMatchObject({ kind: "refused", code: "path_busy" });
	});

	it("does not touch changes elsewhere", () => {
		expect(plan(renamed, putRequest("/workspace/a.txt", "a2", hashA)).kind).toBe("changed");
	});
});
