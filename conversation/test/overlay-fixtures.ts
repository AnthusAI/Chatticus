import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { OverlayEntry } from "@chatticus/host-protocol/edit-overlay";
import type { OverlaySnapshotView, SnapshotNode } from "../src/snapshot/overlay-merge.ts";

export const hashOfText = (text: string): string => createHash("sha256").update(text).digest("hex");

type NodeSpec =
	| { path: string; kind: "file"; content: string; mode?: number }
	| { path: string; kind: "directory"; mode?: number }
	| { path: string; kind: "symlink"; target: string };

/** A snapshot view over a list of nodes, with `/workspace` always present. */
export function snapshotOf(specs: readonly NodeSpec[]): OverlaySnapshotView {
	const nodes = new Map<string, SnapshotNode>();
	nodes.set("/workspace", { path: "/workspace", kind: "directory", size: 0, mode: 0o775, modifiedAtMilliseconds: 1000, sha256: null, linkTarget: null });
	for (const spec of specs) {
		nodes.set(spec.path, {
			path: spec.path,
			kind: spec.kind,
			size: spec.kind === "file" ? Buffer.byteLength(spec.content) : 0,
			mode: spec.kind === "symlink" ? 0o777 : (spec.mode ?? (spec.kind === "directory" ? 0o755 : 0o644)),
			modifiedAtMilliseconds: 1000,
			sha256: spec.kind === "file" ? hashOfText(spec.content) : null,
			linkTarget: spec.kind === "symlink" ? spec.target : null,
		});
	}
	return {
		get: (path) => nodes.get(path),
		children: (directoryPath) => [...nodes.values()].filter((node) => node.path !== "/workspace" && posix.dirname(node.path) === directoryPath),
	};
}

const AT = "2026-10-12T10:00:00.000Z";
const common = (path: string, revision = 1) => ({ path, edited_by: "mia", edited_at: AT, revision, conflict: null });

export const putEntry = (path: string, content: string, base: string | null, options: Partial<Extract<OverlayEntry, { op: "put" }>> = {}): Extract<OverlayEntry, { op: "put" }> => ({
	op: "put",
	...common(path),
	sha256: hashOfText(content),
	size: Buffer.byteLength(content),
	mode: "644",
	base_sha256: base,
	from: null,
	from_sha256: null,
	...options,
});

export const deleteFileEntry = (path: string, base: string, options: Partial<Extract<OverlayEntry, { op: "delete" }>> = {}): Extract<OverlayEntry, { op: "delete" }> => ({
	op: "delete",
	...common(path),
	directory: false,
	recursive: false,
	base_sha256: base,
	tree_sha256: null,
	...options,
});

export const deleteDirectoryEntry = (path: string, recursive: boolean, tree: string | null): Extract<OverlayEntry, { op: "delete" }> => ({
	op: "delete",
	...common(path),
	directory: true,
	recursive,
	base_sha256: null,
	tree_sha256: tree,
});

export const mkdirEntry = (path: string): Extract<OverlayEntry, { op: "mkdir" }> => ({ op: "mkdir", ...common(path), mode: "775" });

export const moveFileEntry = (from: string, to: string, content: string): Extract<OverlayEntry, { op: "move" }> => ({
	op: "move",
	...common(to),
	from,
	directory: false,
	sha256: hashOfText(content),
	tree_sha256: null,
	size: Buffer.byteLength(content),
	mode: "644",
});

export const moveDirectoryEntry = (from: string, to: string, tree: string): Extract<OverlayEntry, { op: "move" }> => ({
	op: "move",
	...common(to),
	from,
	directory: true,
	sha256: null,
	tree_sha256: tree,
	size: 0,
	mode: "755",
});
