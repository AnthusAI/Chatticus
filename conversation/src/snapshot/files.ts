import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { OverlayEntry } from "@chatticus/host-protocol/edit-overlay";
import { livePathProblem, looksBinary, looksLikeSecretFile, normalizeLivePath, trimToCharacterBoundary } from "@chatticus/host-protocol/live-file-rules";
import { LIVE_FILE_ERROR_STATUS, LIVE_FILE_LISTING_MAX_ENTRIES } from "@chatticus/host-protocol/live-files";
import zlib from "node:zlib";
import { WORKSPACE_DIRNAME } from "../browser-profiles.ts";
import { formatLogLine } from "../observability/log-line.ts";
import { indexChecksumOf, parseIndex, type SnapshotIndexEntry } from "./index-format.ts";
import { OverlayTreeTooLargeError, createEffectiveView, snapshotViewOfIndex, type EffectiveNode, type EffectiveView } from "./overlay-merge.ts";
import { SnapshotObjectMissingError } from "./pack.ts";
import type { SnapshotManifest, SnapshotReadStore } from "./store.ts";
import { snapshotUri } from "./uri.ts";

/** The most entries one directory listing returns. */
export const MAX_LISTED_ENTRIES = LIVE_FILE_LISTING_MAX_ENTRIES;

/** The most bytes one content read returns. */
export const MAX_CONTENT_RANGE_BYTES = 262144;

/** The most symbolic links one read follows. */
export const MAX_SYMLINK_HOPS = 8;

const INVALID_PATH_MESSAGES = {
	empty: "A path is required.",
	too_long: "The path is longer than 1024 characters.",
	nul: "The path holds a NUL character.",
	not_absolute: "The path must be absolute.",
	dot_dot: "The path must not contain '..'.",
	outside_workspace: "The path must be under /workspace.",
} as const;

const TAR_BLOCK_BYTES = 512;

const INDEX_CACHE_ENTRIES = 4;

/** The codes a read of the saved copy answers with; the statuses are those of `LIVE_FILE_ERROR_STATUS`. */
export type SnapshotFileErrorCode =
	| "invalid_path"
	| "invalid_range"
	| "no_snapshot"
	| "not_found"
	| "snapshot_not_indexed"
	| "range_too_large"
	| "not_a_file"
	| "not_a_directory"
	| "too_many_entries"
	| "too_many_symlinks"
	| "corrupt_snapshot";

/** A file request the snapshot cannot satisfy, with the code and status the route answers with. */
export class SnapshotFileError extends Error {
	readonly code: SnapshotFileErrorCode;

	constructor(code: SnapshotFileErrorCode, message: string) {
		super(message);
		this.name = "SnapshotFileError";
		this.code = code;
	}

	get status(): number {
		return LIVE_FILE_ERROR_STATUS[this.code];
	}
}

/** The overlay of a computer as the file reads see it: the pending entries and a way to read the blob of a saved edit. */
export interface OverlayReadView {
	readonly entries: readonly OverlayEntry[];
	/** The bytes of the blob with this hash, verified against it. */
	readBlob(sha256: string): Promise<Buffer>;
}

/** One entry as the file routes render it. */
export interface FileEntryPayload {
	name: string;
	path: string;
	kind: "file" | "directory" | "symlink";
	size: number | null;
	mode: string | null;
	sha256: string | null;
	link_target: string | null;
	modified_at: string | null;
	overlay: "none" | "pending" | "conflict";
	tree_sha256: string | null;
}

/** The answer to a listing. */
export interface FileListing {
	source: "snapshot";
	as_of: string | null;
	path: string;
	truncated: boolean;
	entries: FileEntryPayload[];
}

/** The answer to a stat. */
export interface FileStat {
	source: "snapshot";
	as_of: string | null;
	entry: FileEntryPayload;
}

/** The answer to a content read. */
export interface FileContent {
	source: "snapshot";
	as_of: string | null;
	path: string;
	size: number;
	sha256: string;
	encoding: "utf8" | "base64";
	binary: boolean;
	offset: number;
	length: number;
	content: string;
	truncated: boolean;
	masked: boolean;
	revealed: boolean;
	modified_at: string | null;
	overlay: "none" | "pending" | "conflict";
	mine_sha256: string | null;
}

/** How a content read treats a masked file and an overlay conflict. */
export interface ContentReadOptions {
	readonly overlay?: OverlayReadView | null;
	/** Return the content of a masked file; the caller has audited the reveal. */
	readonly reveal?: boolean;
	/** Return the person's version of a path whose overlay entry conflicts with a newer snapshot. */
	readonly variant?: "mine";
}

/**
 * Normalise the path of a file request to an index path.
 *
 * The path must start with `/workspace`, be at most 1024 characters, hold no NUL and no `..` segment. `/workspace/src/a.c`
 * maps to the index entry `workspace/src/a.c`.
 *
 * @param raw The path as the client sent it.
 * @returns The index path, without a leading or trailing slash.
 * @throws SnapshotFileError With code `invalid_path`.
 */
export function indexPathOf(raw: string | undefined): string {
	if (raw === undefined) throw new SnapshotFileError("invalid_path", "A path is required.");
	const problem = livePathProblem(raw);
	if (problem !== null) throw new SnapshotFileError("invalid_path", INVALID_PATH_MESSAGES[problem]);
	return normalizeLivePath(raw).slice(1);
}

/** A snapshot's entries, looked up by path and by directory. */
export interface LoadedIndex {
	byPath: ReadonlyMap<string, SnapshotIndexEntry>;
	childrenOf: ReadonlyMap<string, readonly SnapshotIndexEntry[]>;
}

/** Build the lookups the routes need from the entries of an index. */
export function loadedIndexOf(entries: readonly SnapshotIndexEntry[]): LoadedIndex {
	const byPath = new Map<string, SnapshotIndexEntry>();
	const children = new Map<string, SnapshotIndexEntry[]>();
	for (const entry of entries) {
		byPath.set(entry.path, entry);
		const parent = posix.dirname(entry.path);
		const siblings = children.get(parent);
		if (siblings === undefined) children.set(parent, [entry]);
		else siblings.push(entry);
	}
	return { byPath, childrenOf: children };
}

/**
 * Follow symbolic links inside the effective view, at most eight of them, only to targets under `/workspace`.
 *
 * @throws SnapshotFileError `not_found` for a target outside `/workspace` or absent from the view, `too_many_symlinks` past eight hops.
 */
export function followSymlinks(view: EffectiveView, start: EffectiveNode): EffectiveNode {
	let node = start;
	let hops = 0;
	while (node.kind === "symlink") {
		hops += 1;
		if (hops > MAX_SYMLINK_HOPS) throw new SnapshotFileError("too_many_symlinks", `More than ${MAX_SYMLINK_HOPS} symbolic links in a row.`);
		const target = posix.normalize(posix.join(posix.dirname(node.path), node.linkTarget ?? ""));
		if (target !== `/${WORKSPACE_DIRNAME}` && !target.startsWith(`/${WORKSPACE_DIRNAME}/`)) {
			throw new SnapshotFileError("not_found", "The link leads outside /workspace.");
		}
		const next = view.lookup(target);
		if (next === undefined) throw new SnapshotFileError("not_found", "The link leads to nothing in the snapshot.");
		node = next;
	}
	return node;
}

function payloadOf(node: EffectiveNode): FileEntryPayload {
	return {
		name: node.name,
		path: node.path,
		kind: node.kind,
		size: node.size,
		mode: node.mode,
		sha256: node.sha256,
		link_target: node.linkTarget,
		modified_at: node.modifiedAt,
		overlay: node.overlay,
		tree_sha256: null,
	};
}

type OpenSnapshot = { uri: string; manifest: SnapshotManifest | null; index: LoadedIndex | null };

class CorruptMemberError extends Error {}

const indexCache = new Map<string, LoadedIndex>();

/** Forget every cached index; for tests. */
export function clearIndexCache(): void {
	indexCache.clear();
}

function paddedSizeOf(size: number): number {
	const remainder = size % TAR_BLOCK_BYTES;
	return remainder === 0 ? size : size + TAR_BLOCK_BYTES - remainder;
}

const viewOf = (snapshot: OpenSnapshot, overlay: OverlayReadView | null | undefined): EffectiveView =>
	createEffectiveView(snapshotViewOfIndex(snapshot.index), overlay?.entries ?? []);

/**
 * Reads a published snapshot without opening the whole pack, with the edit overlay merged over it: the manifest names the
 * index, the index lists every entry and where each file's gzip member lives, and a file read is one ranged read of that
 * member. A computer that never published, but has pending edits, is an empty `/workspace` plus those edits. It writes
 * nothing.
 */
export class SnapshotFileService {
	private readonly store: SnapshotReadStore;

	constructor(store: SnapshotReadStore) {
		this.store = store;
	}

	/** List one directory: directories first, then by name, at most 2000 entries. */
	async list(tenantId: string, computerId: string, rawPath: string | undefined, overlay?: OverlayReadView | null): Promise<FileListing> {
		const path = `/${indexPathOf(rawPath)}`;
		const snapshot = await this.open(tenantId, computerId, overlay);
		const view = viewOf(snapshot, overlay);
		const found = view.lookup(path);
		if (found === undefined) throw new SnapshotFileError("not_found", "No such path in the snapshot.");
		const directory = followSymlinks(view, found);
		if (directory.kind !== "directory") throw new SnapshotFileError("not_a_directory", "The path is not a directory.");
		const listed = view.list(directory.path);
		return {
			source: "snapshot",
			as_of: snapshot.manifest?.published_at ?? null,
			path,
			truncated: listed.truncated,
			entries: listed.entries.map(payloadOf),
		};
	}

	/**
	 * One entry, as it is, without following a symbolic link. A directory carries its tree hash and a symbolic link its link
	 * hash (section 7.8.2), which are the hashes a delete or a rename must be given back.
	 *
	 * @throws SnapshotFileError `too_many_entries` for a directory with more than 5000 descendants.
	 */
	async stat(tenantId: string, computerId: string, rawPath: string | undefined, overlay?: OverlayReadView | null): Promise<FileStat> {
		const path = `/${indexPathOf(rawPath)}`;
		const snapshot = await this.open(tenantId, computerId, overlay);
		const view = viewOf(snapshot, overlay);
		const node = view.lookup(path);
		if (node === undefined) throw new SnapshotFileError("not_found", "No such path in the snapshot.");
		const entry = payloadOf(node);
		try {
			if (node.kind === "directory") entry.tree_sha256 = view.hashOf(path);
			else if (node.kind === "symlink") entry.sha256 = view.hashOf(path);
		} catch (error) {
			if (error instanceof OverlayTreeTooLargeError) throw new SnapshotFileError("too_many_entries", error.message);
			throw error;
		}
		return { source: "snapshot", as_of: snapshot.manifest?.published_at ?? null, entry };
	}

	/**
	 * Where the bytes of a file would come from: `overlay` when a pending edit supplies them, `snapshot` otherwise. A reveal
	 * is audited with this before anything is read.
	 *
	 * @throws SnapshotFileError When the path does not lead to a file.
	 */
	async originOf(tenantId: string, computerId: string, rawPath: string | undefined, overlay?: OverlayReadView | null): Promise<"overlay" | "snapshot"> {
		const path = `/${indexPathOf(rawPath)}`;
		const snapshot = await this.open(tenantId, computerId, overlay);
		const view = viewOf(snapshot, overlay);
		const found = view.lookup(path);
		if (found === undefined) throw new SnapshotFileError("not_found", "No such path in the snapshot.");
		const node = followSymlinks(view, found);
		if (node.kind !== "file") throw new SnapshotFileError("not_a_file", "The path is not a file.");
		return node.overlay === "pending" ? "overlay" : "snapshot";
	}

	/**
	 * Read a byte range of one file. A file of the snapshot is fetched with one ranged read of its gzip member,
	 * decompressed, and its SHA-256 checked against the index before any byte is returned; the text of a pending edit is
	 * checked against the hash of its entry.
	 */
	async content(
		tenantId: string,
		computerId: string,
		rawPath: string | undefined,
		range: { offset: number; length: number },
		options: ContentReadOptions = {},
	): Promise<FileContent> {
		const path = `/${indexPathOf(rawPath)}`;
		if (range.length > MAX_CONTENT_RANGE_BYTES) {
			throw new SnapshotFileError("range_too_large", `A read returns at most ${MAX_CONTENT_RANGE_BYTES} bytes.`);
		}
		let snapshot = await this.open(tenantId, computerId, options.overlay);
		for (let attempt = 1; ; attempt += 1) {
			try {
				return await this.readContent(snapshot, path, range, options);
			} catch (error) {
				if (!(error instanceof CorruptMemberError)) throw error;
				const fresh = await this.open(tenantId, computerId, options.overlay);
				if (attempt === 1 && fresh.manifest?.checksum !== snapshot.manifest?.checksum) {
					snapshot = fresh;
					continue;
				}
				console.error(formatLogLine("snapshot_member_corrupt", { tenant_id: tenantId, computer_id: computerId, path, reason: error.message }));
				throw new SnapshotFileError("corrupt_snapshot", "The stored file does not match the snapshot index.");
			}
		}
	}

	private async open(tenantId: string, computerId: string, overlay: OverlayReadView | null | undefined): Promise<OpenSnapshot> {
		const uri = snapshotUri(tenantId, computerId, { bucket: this.store.bucket });
		let manifest: SnapshotManifest;
		try {
			manifest = await Promise.resolve(this.store.getManifest(uri));
		} catch (error) {
			if (!(error instanceof SnapshotObjectMissingError)) throw error;
			if ((overlay?.entries.length ?? 0) > 0) return { uri, manifest: null, index: null };
			throw new SnapshotFileError("no_snapshot", "This computer has not published a snapshot.");
		}
		if (manifest.index_checksum === undefined) {
			throw new SnapshotFileError("snapshot_not_indexed", "The snapshot has no index yet; it needs to be published again or re-indexed.");
		}
		const cacheKey = `${uri}|${manifest.checksum}|${manifest.index_checksum}`;
		let index = indexCache.get(cacheKey);
		if (index === undefined) {
			let bytes: Buffer;
			try {
				bytes = await Promise.resolve(this.store.getIndexBytes(uri, manifest.checksum));
			} catch (error) {
				if (error instanceof SnapshotObjectMissingError) throw new SnapshotFileError("corrupt_snapshot", "The snapshot manifest names an index that is missing.");
				throw error;
			}
			if (indexChecksumOf(bytes) !== manifest.index_checksum) {
				throw new SnapshotFileError("corrupt_snapshot", "The snapshot index does not match the manifest.");
			}
			index = loadedIndexOf(parseIndex(bytes).entries);
			indexCache.set(cacheKey, index);
			while (indexCache.size > INDEX_CACHE_ENTRIES) {
				indexCache.delete(indexCache.keys().next().value!);
			}
		} else {
			indexCache.delete(cacheKey);
			indexCache.set(cacheKey, index);
		}
		return { uri, manifest, index };
	}

	private async readContent(snapshot: OpenSnapshot, path: string, range: { offset: number; length: number }, options: ContentReadOptions): Promise<FileContent> {
		const view = viewOf(snapshot, options.overlay);
		const found = view.lookup(path);
		if (found === undefined) throw new SnapshotFileError("not_found", "No such path in the snapshot.");
		const node = followSymlinks(view, found);
		if (node.kind !== "file") throw new SnapshotFileError("not_a_file", "The path is not a file.");
		const mine = options.variant === "mine";
		if (mine && (node.overlay !== "conflict" || node.mineSha256 === null)) {
			throw new SnapshotFileError("not_found", "That file has no version of yours that conflicts with the saved copy.");
		}
		const asOf = snapshot.manifest?.published_at ?? null;
		const shown = {
			source: "snapshot" as const,
			as_of: asOf,
			path,
			revealed: options.reveal === true,
			modified_at: node.modifiedAt,
			overlay: node.overlay,
			mine_sha256: node.mineSha256,
		};
		if (options.reveal !== true && (looksLikeSecretFile(node.path) || looksLikeSecretFile(path))) {
			return { ...shown, size: node.size ?? 0, sha256: mine ? (node.mineSha256 ?? "") : (node.sha256 ?? ""), encoding: "utf8", binary: false, offset: range.offset, length: 0, content: "", truncated: false, masked: true };
		}
		const data = mine ? await this.readBlob(options.overlay, node.mineSha256!) : await this.readNodeBytes(snapshot, node, options.overlay);
		const binary = looksBinary(data);
		const requested = data.subarray(Math.min(range.offset, data.length), Math.min(range.offset + range.length, data.length));
		const slice = binary ? requested : trimToCharacterBoundary(requested);
		return {
			...shown,
			size: data.length,
			sha256: createHash("sha256").update(data).digest("hex"),
			encoding: binary ? "base64" : "utf8",
			binary,
			offset: range.offset,
			length: slice.length,
			content: binary ? slice.toString("base64") : slice.toString("utf8"),
			truncated: Math.min(range.offset, data.length) + slice.length < data.length,
			masked: false,
		};
	}

	private async readBlob(overlay: OverlayReadView | null | undefined, sha256: string): Promise<Buffer> {
		if (overlay === null || overlay === undefined) throw new SnapshotFileError("not_found", "There is no overlay to read.");
		return overlay.readBlob(sha256);
	}

	private async readNodeBytes(snapshot: OpenSnapshot, node: EffectiveNode, overlay: OverlayReadView | null | undefined): Promise<Buffer> {
		if (node.source.type === "blob") return this.readBlob(overlay, node.source.sha256);
		if (node.source.type !== "snapshot" || snapshot.index === null) throw new SnapshotFileError("not_a_file", "The path is not a file.");
		const entry = snapshot.index.byPath.get(node.source.path.slice(1));
		if (entry === undefined) throw new CorruptMemberError("the index entry of a moved file is gone");
		return this.readVerifiedFile(snapshot, entry);
	}

	private async readVerifiedFile(snapshot: OpenSnapshot, entry: SnapshotIndexEntry): Promise<Buffer> {
		if (entry.offset === null || entry.length === null || entry.sha256 === null) {
			throw new CorruptMemberError("the index entry has no location in the pack");
		}
		const compressed = await Promise.resolve(this.store.getPackRange(snapshot.uri, entry.offset, entry.length));
		if (compressed.length !== entry.length) throw new CorruptMemberError("the stored member is shorter than the index says");
		const padded = paddedSizeOf(entry.size);
		let plain: Buffer;
		try {
			plain = zlib.gunzipSync(compressed, { maxOutputLength: padded + 16 * TAR_BLOCK_BYTES });
		} catch {
			throw new CorruptMemberError("the stored member does not decompress");
		}
		const headerLength = plain.length - padded;
		if (headerLength < TAR_BLOCK_BYTES || headerLength % TAR_BLOCK_BYTES !== 0) {
			throw new CorruptMemberError("the stored member has an unexpected size");
		}
		const data = plain.subarray(headerLength, headerLength + entry.size);
		if (createHash("sha256").update(data).digest("hex") !== entry.sha256) {
			throw new CorruptMemberError("the stored bytes do not match the indexed hash");
		}
		return data;
	}
}
