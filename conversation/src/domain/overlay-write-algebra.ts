import { posix } from "node:path";
import {
	OVERLAY_INDEX_MAX_BYTES,
	OVERLAY_INDEX_VERSION,
	OVERLAY_MAX_ENTRIES,
	OVERLAY_MAX_TOTAL_BYTES,
	type OverlayEntry,
} from "@chatticus/host-protocol/edit-overlay";
import { LIVE_FILE_CONTENT_MAX_BYTES } from "@chatticus/host-protocol/live-files";
import { livePathHasGitSegment } from "@chatticus/host-protocol/live-file-rules";
import { PACK_EXCLUDED_DIRECTORY_NAMES } from "../snapshot/exclusions.ts";
import {
	OVERLAY_WORKSPACE_ROOT,
	OverlayTreeTooLargeError,
	createEffectiveView,
	hashOfLeafNode,
	isSameOrUnder,
	isStrictlyUnder,
	snapshotTreeHash,
	type EffectiveView,
	type OverlaySnapshotView,
} from "../snapshot/overlay-merge.ts";

/** Why a requested change cannot be recorded. Each code has one HTTP status in the member routes (section 6.3). */
export type OverlayRefusalCode =
	| "path_refused"
	| "not_in_saved_copy"
	| "not_found"
	| "parent_missing"
	| "not_a_file"
	| "not_a_directory"
	| "already_exists"
	| "precondition_failed"
	| "overlay_full"
	| "path_busy"
	| "directory_not_empty"
	| "owner_role_required"
	| "invalid_move"
	| "too_many_entries"
	| "file_too_large";

/** A change to the overlay as a member asked for it. Content is already hashed and stored by the caller; the algebra sees only its hash and size. */
export type OverlayChangeRequest =
	| {
			readonly op: "put";
			readonly path: string;
			readonly sha256: string;
			readonly size: number;
			readonly precondition: { readonly type: "if_match"; readonly sha256: string } | { readonly type: "if_none_match" };
	  }
	| { readonly op: "delete"; readonly path: string; readonly recursive: boolean; readonly ownerRole: boolean; readonly ifMatchSha256: string }
	| { readonly op: "move"; readonly from: string; readonly to: string; readonly ifMatchSha256: string }
	| { readonly op: "mkdir"; readonly path: string };

/** What the algebra decided. */
export type OverlayPlan =
	| { readonly kind: "refused"; readonly code: OverlayRefusalCode; readonly message: string; readonly currentSha256?: string | null }
	| { readonly kind: "unchanged"; readonly created: boolean; readonly sha256: string | null; readonly previousSha256: string | null }
	| {
			readonly kind: "changed";
			readonly entries: readonly OverlayEntry[];
			/** The path as it stands after the change, for the audit trail and the response (a move: the target). */
			readonly path: string;
			readonly created: boolean;
			readonly previousSha256: string | null;
			readonly resultSha256: string | null;
			readonly directory: boolean;
			/** For a delete: the files, links and directories the change removes from the effective view. */
			readonly removed: number;
	  };

/** Everything the algebra reads: the snapshot, the entries as they stand, the request and who made it. */
export type OverlayPlanInput = {
	readonly snapshot: OverlaySnapshotView;
	readonly entries: readonly OverlayEntry[];
	readonly request: OverlayChangeRequest;
	readonly editedBy: string;
	readonly editedAt: string;
};

const MKDIR_MODE = "775";
const DEFAULT_FILE_MODE = "664";

const refuse = (code: OverlayRefusalCode, message: string, currentSha256?: string | null): OverlayPlan => ({
	kind: "refused",
	code,
	message,
	...(currentSha256 === undefined ? {} : { currentSha256 }),
});

class Refused extends Error {
	readonly plan: OverlayPlan;
	constructor(code: OverlayRefusalCode, message: string, currentSha256?: string | null) {
		super(message);
		this.plan = refuse(code, message, currentSha256);
	}
}

const segmentsBelowRoot = (path: string): string[] => (path === OVERLAY_WORKSPACE_ROOT ? [] : path.slice(OVERLAY_WORKSPACE_ROOT.length + 1).split("/"));

function requireOrdinaryPath(path: string): void {
	if (path === OVERLAY_WORKSPACE_ROOT) throw new Refused("path_refused", "The workspace root cannot be changed.");
	if (livePathHasGitSegment(path)) throw new Refused("path_refused", "Paths inside .git are not edited.");
	if (segmentsBelowRoot(path).some((segment) => PACK_EXCLUDED_DIRECTORY_NAMES.has(segment))) {
		throw new Refused("not_in_saved_copy", "The saved copy never keeps files under this directory name.");
	}
}

function requireUsableParent(view: EffectiveView, path: string): void {
	const parent = posix.dirname(path);
	let ancestor = parent;
	while (ancestor !== OVERLAY_WORKSPACE_ROOT && ancestor.length > OVERLAY_WORKSPACE_ROOT.length) {
		if (view.lookup(ancestor)?.kind === "symlink") throw new Refused("path_refused", "A link in the path is not followed.");
		ancestor = posix.dirname(ancestor);
	}
	const node = view.lookup(parent);
	if (node === undefined) throw new Refused("parent_missing", "The folder does not exist.");
	if (node.kind !== "directory") throw new Refused("not_a_directory", "The parent is not a folder.");
}

type ExclusiveEntry = { readonly entry: OverlayEntry; readonly covers: readonly string[] };

function exclusiveEntriesOf(entries: readonly OverlayEntry[], view: EffectiveView): ExclusiveEntry[] {
	const found: ExclusiveEntry[] = [];
	for (const entry of entries) {
		if (view.states.get(entry.path) !== "pending") continue;
		if (entry.op === "move" && entry.directory) found.push({ entry, covers: [entry.path, entry.from] });
		else if (entry.op === "delete" && entry.directory && entry.recursive) found.push({ entry, covers: [entry.path] });
	}
	return found;
}

function requireNotBusy(entries: readonly OverlayEntry[], view: EffectiveView, paths: readonly string[]): void {
	for (const { covers } of exclusiveEntriesOf(entries, view)) {
		if (paths.some((path) => covers.some((cover) => isSameOrUnder(path, cover)))) {
			throw new Refused("path_busy", "A folder rename or delete that covers this path is waiting for the computer. Wait for it or discard it.");
		}
	}
}

function requireNoEntryInside(entries: readonly OverlayEntry[], paths: readonly string[]): void {
	for (const entry of entries) {
		const named = [entry.path, ...(("from" in entry && entry.from !== null) ? [entry.from] : [])];
		if (named.some((name) => paths.some((path) => isSameOrUnder(name, path)))) {
			throw new Refused("path_busy", "Another change is waiting inside this folder. Wait for it or discard it.");
		}
	}
}

function requirePathFreeOfOtherEntries(entries: readonly OverlayEntry[], view: EffectiveView, path: string): void {
	for (const entry of entries) {
		const state = view.states.get(entry.path);
		const occupies = entry.path === path && state === "pending";
		const sourceOfOther = "from" in entry && entry.from === path && state === "pending";
		if (occupies || sourceOfOther) throw new Refused("path_busy", "Another change is already waiting at this path. Wait for it or discard it.");
	}
}

function capsRefusal(entries: readonly OverlayEntry[]): OverlayPlan | null {
	const bytes = entries.reduce((total, entry) => total + (entry.op === "put" ? entry.size : 0), 0);
	const index = Buffer.byteLength(JSON.stringify({ version: OVERLAY_INDEX_VERSION, sealed: null, entries }));
	if (entries.length > OVERLAY_MAX_ENTRIES || bytes > OVERLAY_MAX_TOTAL_BYTES || index > OVERLAY_INDEX_MAX_BYTES) {
		return refuse("overlay_full", "The pending changes hold the most they can until the computer applies them.");
	}
	return null;
}

const entryAt = (entries: readonly OverlayEntry[], path: string): OverlayEntry | undefined => entries.find((entry) => entry.path === path);
const without = (entries: readonly OverlayEntry[], ...paths: string[]): OverlayEntry[] => entries.filter((entry) => !paths.includes(entry.path));
const revisionAfter = (existing: OverlayEntry | undefined): number => (existing === undefined ? 1 : existing.revision + 1);
const stamp = (input: OverlayPlanInput, revision: number) => ({ edited_by: input.editedBy, edited_at: input.editedAt, revision, conflict: null });

function planPut(input: OverlayPlanInput, view: EffectiveView, request: Extract<OverlayChangeRequest, { op: "put" }>): OverlayPlan {
	const { path } = request;
	requireOrdinaryPath(path);
	if (request.size > LIVE_FILE_CONTENT_MAX_BYTES) throw new Refused("file_too_large", "Content over 256 KiB is not edited here.");
	requireNotBusy(input.entries, view, [path]);
	requireUsableParent(view, path);
	const node = view.lookup(path);
	if (node?.kind === "symlink") throw new Refused("path_refused", "A link is not edited.");
	if (node?.kind === "directory") throw new Refused("not_a_file", "The path is a folder.");
	if (node !== undefined && (node.size ?? 0) > LIVE_FILE_CONTENT_MAX_BYTES) throw new Refused("file_too_large", "A file over 256 KiB is not replaced here.");
	const effectiveHash = node?.sha256 ?? null;
	if (request.precondition.type === "if_none_match" && node !== undefined) throw new Refused("already_exists", "A file is already there.", effectiveHash);
	if (request.precondition.type === "if_match" && request.precondition.sha256 !== effectiveHash) {
		throw new Refused("precondition_failed", "The file changed since it was read.", effectiveHash);
	}
	const existing = entryAt(input.entries, path);
	const state = existing === undefined ? undefined : view.states.get(path);
	if (existing?.op === "delete" && existing.directory && state === "pending") {
		throw new Refused("path_busy", "A folder delete is waiting at this path. Wait for it or discard it.");
	}
	if (node?.sha256 === request.sha256 && state !== "conflict") {
		return { kind: "unchanged", created: false, sha256: request.sha256, previousSha256: effectiveHash };
	}
	requirePathFreeOfOtherEntries(input.entries.filter((entry) => entry.path !== path), view, path);
	const snapshotNode = input.snapshot.get(path);
	const snapshotHash = snapshotNode === undefined ? null : hashOfLeafNode(snapshotNode);
	const mode =
		existing !== undefined && existing.op !== "delete" && state !== "conflict" ? existing.mode : (node?.mode ?? DEFAULT_FILE_MODE);
	let base = snapshotHash;
	let from: string | null = null;
	let fromSha256: string | null = null;
	if (existing?.op === "put" && state === "pending") {
		base = existing.base_sha256;
		from = existing.from;
		fromSha256 = existing.from_sha256;
	} else if (existing?.op === "move" && state === "pending") {
		base = null;
		from = existing.from;
		fromSha256 = existing.sha256;
	}
	const entry: OverlayEntry = {
		op: "put",
		path,
		sha256: request.sha256,
		size: request.size,
		mode,
		base_sha256: base,
		from,
		from_sha256: fromSha256,
		...stamp(input, revisionAfter(existing)),
	};
	const entries = [...without(input.entries, path), entry];
	return (
		capsRefusal(entries) ?? { kind: "changed", entries, path, created: node === undefined, previousSha256: effectiveHash, resultSha256: request.sha256, directory: false, removed: 0 }
	);
}

function deleteOfSource(entry: OverlayEntry, input: OverlayPlanInput, region: string): OverlayEntry | null {
	if (entry.op === "put" && entry.from !== null) {
		if (isSameOrUnder(entry.from, region)) return null;
		return deleteEntry(entry.from, false, false, entry.from_sha256, null, input, 1);
	}
	if (entry.op === "move") {
		if (isSameOrUnder(entry.from, region)) return null;
		if (!entry.directory) return deleteEntry(entry.from, false, false, entry.sha256, null, input, 1);
		return deleteEntry(entry.from, true, true, null, entry.tree_sha256, input, 1);
	}
	return null;
}

function deleteEntry(
	path: string,
	directory: boolean,
	recursive: boolean,
	base: string | null,
	tree: string | null,
	input: OverlayPlanInput,
	revision: number,
): OverlayEntry {
	return { op: "delete", path, directory, recursive, base_sha256: base, tree_sha256: tree, ...stamp(input, revision) };
}

function planDelete(input: OverlayPlanInput, view: EffectiveView, request: Extract<OverlayChangeRequest, { op: "delete" }>): OverlayPlan {
	const { path } = request;
	requireOrdinaryPath(path);
	requireNotBusy(input.entries, view, [path]);
	const node = view.lookup(path);
	if (node === undefined) throw new Refused("not_found", "Nothing is there.");
	const isDirectory = node.kind === "directory";
	const nonEmpty = isDirectory && view.list(path, 1).entries.length > 0;
	if (nonEmpty && !request.recursive) throw new Refused("directory_not_empty", "The folder is not empty.");
	if (nonEmpty && !request.ownerRole) throw new Refused("owner_role_required", "Only an owner of the organization deletes a folder that is not empty.");
	const effectiveHash = view.hashOf(path);
	if (effectiveHash !== request.ifMatchSha256) throw new Refused("precondition_failed", "It changed since it was read.", effectiveHash);
	const existing = entryAt(input.entries, path);
	const existingState = existing === undefined ? undefined : view.states.get(path);
	const pending = existingState === "pending";
	const finish = (entries: OverlayEntry[], removed: number): OverlayPlan =>
		capsRefusal(entries) ?? { kind: "changed", entries, path, created: false, previousSha256: effectiveHash, resultSha256: null, directory: isDirectory, removed };

	if (!isDirectory) {
		const remainder = without(input.entries, path);
		if (pending && existing?.op === "put") {
			if (existing.from === null && existing.base_sha256 === null) return finish(remainder, 1);
			if (existing.from === null) return finish([...remainder, deleteEntry(path, false, false, existing.base_sha256, null, input, revisionAfter(existing))], 1);
			return finish([...remainder, deleteEntry(existing.from, false, false, existing.from_sha256, null, input, 1)], 1);
		}
		if (pending && existing?.op === "move") {
			return finish([...remainder, deleteEntry(existing.from, false, false, existing.sha256, null, input, 1)], 1);
		}
		const snapshotNode = input.snapshot.get(path);
		const base = snapshotNode === undefined ? effectiveHash : hashOfLeafNode(snapshotNode);
		return finish([...remainder, deleteEntry(path, false, false, base, null, input, revisionAfter(existing))], 1);
	}

	const snapshotDirectory = input.snapshot.get(path);
	const snapshotHoldsChildren = snapshotDirectory?.kind === "directory" && input.snapshot.children(path).length > 0;
	if (!nonEmpty && !snapshotHoldsChildren) {
		if (pending && existing?.op === "mkdir") return finish(without(input.entries, path), 1);
		return finish([...without(input.entries, path), deleteEntry(path, true, false, null, null, input, revisionAfter(existing))], 1);
	}
	for (const entry of input.entries) {
		const movesOut = "from" in entry && entry.from !== null && isSameOrUnder(entry.from, path) && !isSameOrUnder(entry.path, path);
		if (movesOut) throw new Refused("path_busy", "A change that takes a file out of this folder is waiting. Wait for it or discard it.");
	}
	const dropped = input.entries.filter((entry) => isSameOrUnder(entry.path, path));
	const kept = input.entries.filter((entry) => !isSameOrUnder(entry.path, path));
	const sourceDeletes = dropped.flatMap((entry) => {
		const source = deleteOfSource(entry, input, path);
		return source === null ? [] : [source];
	});
	const removed = view.descendants(path).length + 1;
	if (snapshotDirectory?.kind !== "directory") return finish([...kept, ...sourceDeletes], removed);
	const tree = snapshotTreeHash(input.snapshot, path);
	return finish([...kept, ...sourceDeletes, deleteEntry(path, true, true, null, tree, input, revisionAfter(existing))], removed);
}

function planMove(input: OverlayPlanInput, view: EffectiveView, request: Extract<OverlayChangeRequest, { op: "move" }>): OverlayPlan {
	const { from, to } = request;
	requireOrdinaryPath(from);
	requireOrdinaryPath(to);
	if (isStrictlyUnder(to, from)) throw new Refused("invalid_move", "A folder cannot be moved into itself.");
	requireNotBusy(input.entries, view, [from, to]);
	const source = view.lookup(from);
	if (source === undefined) throw new Refused("not_found", "Nothing is there.");
	if (view.lookup(to) !== undefined) throw new Refused("already_exists", "Something is already at the new path.", view.hashOf(to));
	requireUsableParent(view, to);
	const effectiveHash = view.hashOf(from);
	if (effectiveHash !== request.ifMatchSha256) throw new Refused("precondition_failed", "It changed since it was read.", effectiveHash);
	requirePathFreeOfOtherEntries(input.entries.filter((entry) => entry.path !== from), view, to);
	const existing = entryAt(input.entries, from);
	const existingState = existing === undefined ? undefined : view.states.get(from);
	const remainder = without(input.entries, from, to);
	const finish = (entries: OverlayEntry[]): OverlayPlan =>
		capsRefusal(entries) ?? {
			kind: "changed",
			entries,
			path: to,
			created: false,
			previousSha256: effectiveHash,
			resultSha256: source.kind === "directory" ? null : effectiveHash,
			directory: source.kind === "directory",
			removed: 0,
		};

	if (source.kind === "directory") {
		requireNoEntryInside(input.entries, [from, to]);
		const tree = snapshotTreeHash(input.snapshot, from);
		const entry: OverlayEntry = {
			op: "move",
			path: to,
			from,
			directory: true,
			sha256: null,
			tree_sha256: tree,
			size: 0,
			mode: source.mode,
			...stamp(input, 1),
		};
		return finish([...remainder, entry]);
	}

	if (existingState === "pending" && existing !== undefined) {
		if (existing.op === "put") {
			if (existing.from === null && existing.base_sha256 === null) {
				return finish([...remainder, { ...existing, path: to, ...stamp(input, existing.revision + 1) }]);
			}
			if (existing.from === null) {
				return finish([...remainder, { ...existing, path: to, base_sha256: null, from, from_sha256: existing.base_sha256, ...stamp(input, existing.revision + 1) }]);
			}
			if (to === existing.from) {
				if (existing.sha256 === existing.from_sha256) return finish(remainder);
				return finish([...remainder, { ...existing, path: to, base_sha256: existing.from_sha256, from: null, from_sha256: null, ...stamp(input, existing.revision + 1) }]);
			}
			return finish([...remainder, { ...existing, path: to, ...stamp(input, existing.revision + 1) }]);
		}
		if (existing.op === "move") {
			if (to === existing.from) return finish(remainder);
			return finish([...remainder, { ...existing, path: to, ...stamp(input, existing.revision + 1) }]);
		}
	}
	const entry: OverlayEntry = {
		op: "move",
		path: to,
		from,
		directory: false,
		sha256: effectiveHash,
		tree_sha256: null,
		size: source.size ?? 0,
		mode: source.mode,
		...stamp(input, 1),
	};
	return finish([...remainder, entry]);
}

function planMkdir(input: OverlayPlanInput, view: EffectiveView, request: Extract<OverlayChangeRequest, { op: "mkdir" }>): OverlayPlan {
	const { path } = request;
	if (path === OVERLAY_WORKSPACE_ROOT) return { kind: "unchanged", created: false, sha256: null, previousSha256: null };
	requireOrdinaryPath(path);
	requireNotBusy(input.entries, view, [path]);
	const node = view.lookup(path);
	if (node?.kind === "directory") return { kind: "unchanged", created: false, sha256: null, previousSha256: null };
	if (node !== undefined) throw new Refused("already_exists", "A file or link is already there.", view.hashOf(path));
	requireUsableParent(view, path);
	requirePathFreeOfOtherEntries(input.entries, view, path);
	const existing = entryAt(input.entries, path);
	const entry: OverlayEntry = { op: "mkdir", path, mode: MKDIR_MODE, ...stamp(input, revisionAfter(existing)) };
	const entries = [...without(input.entries, path), entry];
	return capsRefusal(entries) ?? { kind: "changed", entries, path, created: true, previousSha256: null, resultSha256: null, directory: true, removed: 0 };
}

/**
 * The write algebra of 7.8.4 as a pure function: the entries a request leaves behind, or the reason it is refused, judged
 * against the effective view the entries and the snapshot make. Path rules come first, then the exclusivity of a pending
 * folder rename or recursive delete, then the precondition against the effective hash, then the row of the table, then the
 * caps. No object is read or written here.
 *
 * @param input The snapshot, the entries as they stand, the request, who made it and when.
 * @returns A refusal, a no-op, or the new set of entries.
 */
export function planOverlayChange(input: OverlayPlanInput): OverlayPlan {
	const view = createEffectiveView(input.snapshot, input.entries);
	try {
		switch (input.request.op) {
			case "put":
				return planPut(input, view, input.request);
			case "delete":
				return planDelete(input, view, input.request);
			case "move":
				return planMove(input, view, input.request);
			case "mkdir":
				return planMkdir(input, view, input.request);
		}
	} catch (error) {
		if (error instanceof Refused) return error.plan;
		if (error instanceof OverlayTreeTooLargeError) return refuse("too_many_entries", error.message);
		throw error;
	}
}
