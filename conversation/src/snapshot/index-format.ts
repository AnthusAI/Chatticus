import { createHash } from "node:crypto";
import { SnapshotPackError } from "./pack.ts";

/** What kind of thing one pack entry is. */
export type SnapshotEntryKind = "file" | "directory" | "symlink";

/**
 * One entry of a snapshot index. `path` is relative to the live root, for example `workspace/src/a.c`. Only a file has a
 * hash and a location in the pack: `offset` and `length` are the byte range of the file's own gzip member.
 */
export interface SnapshotIndexEntry {
	path: string;
	kind: SnapshotEntryKind;
	size: number;
	mode: number;
	mtime_ms: number;
	sha256: string | null;
	link_target: string | null;
	offset: number | null;
	length: number | null;
}

/** The sidecar that lists everything in one snapshot pack, so a reader never has to open the pack to list it. */
export interface SnapshotIndex {
	version: 2;
	pack_checksum: string;
	pack_bytes: number;
	entries: SnapshotIndexEntry[];
}

/** The object name of the index of the pack with this checksum, relative to the computer's snapshot prefix. */
export function indexObjectName(packChecksum: string): string {
	return `index/${packChecksum}.json`;
}

/** The serialized bytes of an index; the same index always gives the same bytes. */
export function serializeIndex(index: SnapshotIndex): Buffer {
	return Buffer.from(JSON.stringify(index));
}

/** The SHA-256 hex digest of serialized index bytes; the manifest names it. */
export function indexChecksumOf(serialized: Buffer): string {
	return createHash("sha256").update(serialized).digest("hex");
}

const KINDS: ReadonlySet<string> = new Set(["file", "directory", "symlink"]);

/**
 * Parse serialized index bytes.
 *
 * @throws SnapshotPackError If the bytes are not an index of the supported version.
 */
export function parseIndex(serialized: Buffer): SnapshotIndex {
	let parsed: unknown;
	try {
		parsed = JSON.parse(serialized.toString("utf8"));
	} catch {
		throw new SnapshotPackError("Snapshot index is not valid JSON.");
	}
	const candidate = parsed as Partial<SnapshotIndex> | null;
	if (candidate === null || typeof candidate !== "object" || candidate.version !== 2 || !Array.isArray(candidate.entries)) {
		throw new SnapshotPackError("Snapshot index has an unsupported shape.");
	}
	for (const entry of candidate.entries) {
		if (typeof entry?.path !== "string" || !KINDS.has(entry.kind) || typeof entry.size !== "number") {
			throw new SnapshotPackError("Snapshot index holds a malformed entry.");
		}
	}
	return candidate as SnapshotIndex;
}
