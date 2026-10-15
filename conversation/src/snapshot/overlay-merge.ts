import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { OverlayEntry } from "@chatticus/host-protocol/edit-overlay";
import { LIVE_FILE_TREE_MAX_ENTRIES, LIVE_FILE_LISTING_MAX_ENTRIES } from "@chatticus/host-protocol/live-files";
import { symlinkHashOf, treeHashOf, type LiveTreeDescendant } from "@chatticus/host-protocol/live-file-rules";
import type { LoadedIndex } from "./files.ts";
import type { SnapshotIndexEntry } from "./index-format.ts";

/** The workspace directory, the one path that exists even when nothing was published. */
export const OVERLAY_WORKSPACE_ROOT = "/workspace";

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** One path of the published snapshot, as the merge reads it. The path is a live path (`/workspace/a.txt`). */
export type SnapshotNode = {
	readonly path: string;
	readonly kind: "file" | "directory" | "symlink";
	readonly size: number;
	readonly mode: number;
	readonly modifiedAtMilliseconds: number;
	readonly sha256: string | null;
	readonly linkTarget: string | null;
};

/** The snapshot the overlay is merged over: lookups by path and by directory. */
export interface OverlaySnapshotView {
	get(path: string): SnapshotNode | undefined;
	children(directoryPath: string): readonly SnapshotNode[];
}

/**
 * The merge's view of a loaded snapshot index. A computer that never published has no index: its view holds only the empty
 * `/workspace` directory.
 *
 * @param loaded The loaded index, or null when nothing was published.
 * @returns The snapshot view.
 */
export function snapshotViewOfIndex(loaded: LoadedIndex | null): OverlaySnapshotView {
	const nodeOf = (entry: SnapshotIndexEntry): SnapshotNode => ({
		path: `/${entry.path}`,
		kind: entry.kind,
		size: entry.size,
		mode: entry.mode,
		modifiedAtMilliseconds: entry.mtime_ms,
		sha256: entry.sha256,
		linkTarget: entry.link_target,
	});
	if (loaded === null) {
		const root: SnapshotNode = { path: OVERLAY_WORKSPACE_ROOT, kind: "directory", size: 0, mode: 0o775, modifiedAtMilliseconds: 0, sha256: null, linkTarget: null };
		return { get: (path) => (path === OVERLAY_WORKSPACE_ROOT ? root : undefined), children: () => [] };
	}
	return {
		get: (path) => {
			const entry = loaded.byPath.get(path.slice(1));
			return entry === undefined ? undefined : nodeOf(entry);
		},
		children: (directoryPath) => (loaded.childrenOf.get(directoryPath.slice(1)) ?? []).map(nodeOf),
	};
}

/** Whether `path` is `ancestor` or lies below it. */
export const isSameOrUnder = (path: string, ancestor: string): boolean => path === ancestor || path.startsWith(`${ancestor}/`);

/** Whether `path` lies strictly below `ancestor`. */
export const isStrictlyUnder = (path: string, ancestor: string): boolean => path.startsWith(`${ancestor}/`);

/** A directory with more descendants than the tree hash may cover. */
export class OverlayTreeTooLargeError extends Error {
	constructor() {
		super(`A directory with more than ${LIVE_FILE_TREE_MAX_ENTRIES} entries has no tree hash.`);
		this.name = "OverlayTreeTooLargeError";
	}
}

/** The effective hash of a snapshot node that is not a directory: a file's content hash or a symlink's hash (L49). */
export function hashOfLeafNode(node: SnapshotNode): string | null {
	if (node.kind === "file") return node.sha256;
	if (node.kind === "symlink") return symlinkHashOf(node.linkTarget ?? "", sha256Hex);
	return null;
}

function snapshotDescendants(snapshot: OverlaySnapshotView, directoryPath: string): LiveTreeDescendant[] {
	const found: LiveTreeDescendant[] = [];
	const walk = (path: string): void => {
		for (const child of snapshot.children(path)) {
			if (found.length >= LIVE_FILE_TREE_MAX_ENTRIES) throw new OverlayTreeTooLargeError();
			const relativePath = child.path.slice(directoryPath.length + 1);
			if (child.kind === "file") found.push({ relativePath, kind: "file", size: child.size });
			else if (child.kind === "symlink") found.push({ relativePath, kind: "symlink", target: child.linkTarget ?? "" });
			else {
				found.push({ relativePath, kind: "dir" });
				walk(child.path);
			}
		}
	};
	walk(directoryPath);
	return found;
}

/**
 * The tree hash (L49) of a directory of the snapshot itself, which is what the disk holds before any overlay entry is applied.
 *
 * @throws OverlayTreeTooLargeError With more than 5000 descendants.
 */
export function snapshotTreeHash(snapshot: OverlaySnapshotView, directoryPath: string): string {
	return treeHashOf(snapshotDescendants(snapshot, directoryPath), sha256Hex);
}

/** The hash of any snapshot node: leaf hash, or tree hash for a directory. */
function hashOfSnapshotNode(snapshot: OverlaySnapshotView, node: SnapshotNode): string | null {
	return node.kind === "directory" ? snapshotTreeHash(snapshot, node.path) : hashOfLeafNode(node);
}

/** Where an entry stands against the snapshot: waiting to be applied, already in the snapshot, or in conflict with it. */
export type OverlayEntryState = "pending" | "applied" | "conflict";

const DIRECTORY_MARK = "\u0000directory";

const comparableHash = (node: SnapshotNode | undefined): string | null => {
	if (node === undefined) return null;
	return node.kind === "directory" ? DIRECTORY_MARK : hashOfLeafNode(node);
};

/**
 * The state of one entry derived against the snapshot (7.7.2 and 7.8.3). Applied is judged first: the snapshot already
 * holds the result, whatever else is stored. A stored conflict, or a snapshot that is neither the entry's base nor its
 * result, is a conflict.
 *
 * @param entry The overlay entry.
 * @param snapshot The snapshot.
 * @returns The derived state.
 */
export function overlayEntryStateOf(entry: OverlayEntry, snapshot: OverlaySnapshotView): OverlayEntryState {
	switch (entry.op) {
		case "put": {
			const current = comparableHash(snapshot.get(entry.path));
			if (current === entry.sha256) return "applied";
			if (entry.conflict !== null || current !== entry.base_sha256) return "conflict";
			if (entry.from !== null && comparableHash(snapshot.get(entry.from)) !== entry.from_sha256) return "conflict";
			return "pending";
		}
		case "delete": {
			const node = snapshot.get(entry.path);
			if (node === undefined) return "applied";
			if (entry.conflict !== null) return "conflict";
			if (!entry.directory) return node.kind !== "directory" && hashOfLeafNode(node) === entry.base_sha256 ? "pending" : "conflict";
			if (node.kind !== "directory") return "conflict";
			if (entry.recursive) return snapshotTreeHash(snapshot, node.path) === entry.tree_sha256 ? "pending" : "conflict";
			return snapshot.children(node.path).length === 0 ? "pending" : "conflict";
		}
		case "mkdir": {
			const node = snapshot.get(entry.path);
			if (node?.kind === "directory") return "applied";
			if (entry.conflict !== null || node !== undefined) return "conflict";
			return "pending";
		}
		case "move": {
			const kept = entry.directory ? entry.tree_sha256 : entry.sha256;
			const source = snapshot.get(entry.from);
			const target = snapshot.get(entry.path);
			const matchesKept = (node: SnapshotNode): boolean => (node.kind === "directory") === entry.directory && hashOfSnapshotNode(snapshot, node) === kept;
			if (target !== undefined && source === undefined && matchesKept(target)) return "applied";
			if (entry.conflict !== null) return "conflict";
			return source !== undefined && target === undefined && matchesKept(source) ? "pending" : "conflict";
		}
	}
}

/** Where the bytes of an effective path are read from. */
export type EffectiveSource =
	| { readonly type: "snapshot"; readonly path: string }
	| { readonly type: "blob"; readonly sha256: string }
	| { readonly type: "none" };

/** One path of the effective view, with the overlay state that applies to it. */
export type EffectiveNode = {
	readonly path: string;
	readonly name: string;
	readonly kind: "file" | "directory" | "symlink";
	readonly size: number | null;
	readonly mode: string;
	/** A file's content hash; null for a symlink and a directory (see {@link EffectiveView.hashOf}). */
	readonly sha256: string | null;
	readonly linkTarget: string | null;
	readonly modifiedAt: string | null;
	readonly overlay: "none" | "pending" | "conflict";
	/** The hash of the person's version when an entry in conflict hides a newer snapshot. */
	readonly mineSha256: string | null;
	readonly source: EffectiveSource;
};

const octalModeOf = (mode: number): string => mode.toString(8).padStart(3, "0");
const isoOf = (milliseconds: number): string | null => (milliseconds <= 0 ? null : new Date(milliseconds).toISOString());
const compareNames = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/** The snapshot overlaid with the pending entries, as every read, hash and write judgement sees it. */
export interface EffectiveView {
	/** The state of every entry against the snapshot, keyed by entry path. */
	readonly states: ReadonlyMap<string, OverlayEntryState>;
	/** The node at a path, without following a symlink; undefined when absent or hidden. */
	lookup(path: string): EffectiveNode | undefined;
	/** The children of a directory in listing order (directories first, then by name), cut at 2000. */
	list(directoryPath: string, maxEntries?: number): { readonly entries: readonly EffectiveNode[]; readonly truncated: boolean };
	/** The effective hash (L49) of a path: a file's content, a symlink's hash, or a directory's tree hash; null when absent. */
	hashOf(path: string): string | null;
	/** The descendants of a directory in the effective view, for its tree hash and for deleting it. */
	descendants(directoryPath: string): readonly LiveTreeDescendant[];
}

/**
 * Merge the overlay over the snapshot. Pending entries change the view; an applied entry is already in the snapshot and a
 * conflicting one leaves the snapshot's version showing, marked, so nothing is hidden or invented by a change that cannot be
 * applied.
 *
 * @param snapshot The snapshot.
 * @param entries Every entry of the overlay index.
 * @returns The effective view.
 */
export function createEffectiveView(snapshot: OverlaySnapshotView, entries: readonly OverlayEntry[]): EffectiveView {
	const states = new Map<string, OverlayEntryState>();
	const pendingAt = new Map<string, OverlayEntry>();
	const conflictAt = new Map<string, OverlayEntry>();
	const hiddenLeaves = new Set<string>();
	const hiddenDirectories: string[] = [];
	const movedDirectories: { from: string; to: string }[] = [];
	for (const entry of entries) {
		const state = overlayEntryStateOf(entry, snapshot);
		states.set(entry.path, state);
		if (state === "conflict") {
			conflictAt.set(entry.path, entry);
			continue;
		}
		if (state === "applied") continue;
		if (entry.op === "delete") {
			if (entry.directory) hiddenDirectories.push(entry.path);
			else hiddenLeaves.add(entry.path);
			continue;
		}
		pendingAt.set(entry.path, entry);
		if (entry.op === "put" && entry.from !== null) hiddenLeaves.add(entry.from);
		if (entry.op === "move") {
			if (entry.directory) {
				hiddenDirectories.push(entry.from);
				movedDirectories.push({ from: entry.from, to: entry.path });
			} else hiddenLeaves.add(entry.from);
		}
	}

	const isHidden = (path: string): boolean => hiddenLeaves.has(path) || hiddenDirectories.some((directory) => isSameOrUnder(path, directory));
	const translated = (path: string): string | undefined => {
		const move = movedDirectories.find((candidate) => isStrictlyUnder(path, candidate.to));
		return move === undefined ? undefined : `${move.from}${path.slice(move.to.length)}`;
	};

	const nodeOfSnapshot = (node: SnapshotNode, asPath: string, overlay: EffectiveNode["overlay"], mineSha256: string | null): EffectiveNode => ({
		path: asPath,
		name: posix.basename(asPath),
		kind: node.kind,
		size: node.kind === "file" ? node.size : null,
		mode: octalModeOf(node.mode),
		sha256: node.kind === "file" ? node.sha256 : null,
		linkTarget: node.kind === "symlink" ? node.linkTarget : null,
		modifiedAt: isoOf(node.modifiedAtMilliseconds),
		overlay,
		mineSha256,
		source: { type: "snapshot", path: node.path },
	});

	const nodeOfEntry = (entry: OverlayEntry): EffectiveNode | undefined => {
		const base = { path: entry.path, name: posix.basename(entry.path), modifiedAt: entry.edited_at, overlay: "pending" as const, mineSha256: null };
		if (entry.op === "put") {
			return { ...base, kind: "file", size: entry.size, mode: entry.mode, sha256: entry.sha256, linkTarget: null, source: { type: "blob", sha256: entry.sha256 } };
		}
		if (entry.op === "mkdir") {
			return { ...base, kind: "directory", size: null, mode: entry.mode, sha256: null, linkTarget: null, source: { type: "none" } };
		}
		if (entry.op === "move") {
			const source = snapshot.get(entry.from);
			if (entry.directory) {
				return { ...base, kind: "directory", size: null, mode: entry.mode, sha256: null, linkTarget: null, source: { type: "snapshot", path: entry.from } };
			}
			const kind = source?.kind === "symlink" ? "symlink" : "file";
			return {
				...base,
				kind,
				size: kind === "file" ? entry.size : null,
				mode: entry.mode,
				sha256: kind === "file" ? entry.sha256 : null,
				linkTarget: kind === "symlink" ? (source?.linkTarget ?? null) : null,
				source: { type: "snapshot", path: entry.from },
			};
		}
		return undefined;
	};

	const lookup = (path: string): EffectiveNode | undefined => {
		const entry = pendingAt.get(path);
		if (entry !== undefined) return nodeOfEntry(entry);
		const under = translated(path);
		if (under !== undefined) {
			const node = snapshot.get(under);
			return node === undefined ? undefined : nodeOfSnapshot(node, path, "none", null);
		}
		if (isHidden(path)) return undefined;
		const node = snapshot.get(path);
		if (node === undefined) return undefined;
		const conflicted = conflictAt.get(path);
		if (conflicted === undefined) return nodeOfSnapshot(node, path, "none", null);
		return nodeOfSnapshot(node, path, "conflict", conflicted.op === "put" ? conflicted.sha256 : null);
	};

	const allChildren = (directoryPath: string): EffectiveNode[] => {
		const found = new Map<string, EffectiveNode>();
		const mapped = pendingAt.get(directoryPath);
		const base =
			mapped?.op === "move" && mapped.directory
				? mapped.from
				: (translated(directoryPath) ?? (isHidden(directoryPath) || mapped !== undefined ? undefined : directoryPath));
		if (base !== undefined) {
			for (const child of snapshot.children(base)) {
				const node = lookup(`${directoryPath}/${posix.basename(child.path)}`);
				if (node !== undefined) found.set(node.name, node);
			}
		}
		for (const [path, entry] of pendingAt) {
			if (posix.dirname(path) !== directoryPath) continue;
			const node = nodeOfEntry(entry);
			if (node !== undefined) found.set(node.name, node);
		}
		return [...found.values()];
	};

	const list = (directoryPath: string, maxEntries = LIVE_FILE_LISTING_MAX_ENTRIES) => {
		const sorted = allChildren(directoryPath).sort((left, right) => {
			const leftRank = left.kind === "directory" ? 0 : 1;
			const rightRank = right.kind === "directory" ? 0 : 1;
			return leftRank !== rightRank ? leftRank - rightRank : compareNames(left.name, right.name);
		});
		return { entries: sorted.slice(0, maxEntries), truncated: sorted.length > maxEntries };
	};

	const descendants = (directoryPath: string): LiveTreeDescendant[] => {
		const found: LiveTreeDescendant[] = [];
		const walk = (path: string): void => {
			for (const child of allChildren(path)) {
				if (found.length >= LIVE_FILE_TREE_MAX_ENTRIES) throw new OverlayTreeTooLargeError();
				const relativePath = child.path.slice(directoryPath.length + 1);
				if (child.kind === "file") found.push({ relativePath, kind: "file", size: child.size ?? 0 });
				else if (child.kind === "symlink") found.push({ relativePath, kind: "symlink", target: child.linkTarget ?? "" });
				else {
					found.push({ relativePath, kind: "dir" });
					walk(child.path);
				}
			}
		};
		walk(directoryPath);
		return found;
	};

	const hashOf = (path: string): string | null => {
		const node = lookup(path);
		if (node === undefined) return null;
		if (node.kind === "file") return node.sha256;
		if (node.kind === "symlink") return symlinkHashOf(node.linkTarget ?? "", sha256Hex);
		return treeHashOf(descendants(path), sha256Hex);
	};

	return { states, lookup, list, hashOf, descendants };
}
