import { createHash } from "node:crypto";
import { posix } from "node:path";
import { livePathProblem, looksBinary, looksLikeSecretFile, normalizeLivePath, trimToCharacterBoundary } from "@chatticus/host-protocol/live-file-rules";
import zlib from "node:zlib";
import { WORKSPACE_DIRNAME } from "../browser-profiles.ts";
import { formatLogLine } from "../observability/log-line.ts";
import { indexChecksumOf, parseIndex, type SnapshotIndexEntry } from "./index-format.ts";
import { SnapshotObjectMissingError } from "./pack.ts";
import type { SnapshotManifest, SnapshotReadStore } from "./store.ts";
import { snapshotUri } from "./uri.ts";

/** The most entries one directory listing returns. */
export const MAX_LISTED_ENTRIES = 2000;

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

/** The error codes a file route answers with, each with the HTTP status it carries. */
export const SNAPSHOT_FILE_ERROR_STATUS = {
	invalid_path: 400,
	invalid_range: 400,
	no_snapshot: 404,
	not_found: 404,
	snapshot_not_indexed: 409,
	range_too_large: 413,
	not_a_file: 422,
	not_a_directory: 422,
	too_many_symlinks: 422,
	corrupt_snapshot: 500,
} as const;

/** One of the codes in `SNAPSHOT_FILE_ERROR_STATUS`. */
export type SnapshotFileErrorCode = keyof typeof SNAPSHOT_FILE_ERROR_STATUS;

/** A file request the snapshot cannot satisfy, with the code and status the route answers with. */
export class SnapshotFileError extends Error {
	readonly code: SnapshotFileErrorCode;

	constructor(code: SnapshotFileErrorCode, message: string) {
		super(message);
		this.name = "SnapshotFileError";
		this.code = code;
	}

	get status(): number {
		return SNAPSHOT_FILE_ERROR_STATUS[this.code];
	}
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
 * Follow symbolic links inside the index, at most eight of them, only to targets under `workspace/`.
 *
 * @throws SnapshotFileError `not_found` for a target outside `workspace/` or absent from the index, `too_many_symlinks` past eight hops.
 */
export function followSymlinks(index: LoadedIndex, start: SnapshotIndexEntry): SnapshotIndexEntry {
	let entry = start;
	let hops = 0;
	while (entry.kind === "symlink") {
		hops += 1;
		if (hops > MAX_SYMLINK_HOPS) throw new SnapshotFileError("too_many_symlinks", `More than ${MAX_SYMLINK_HOPS} symbolic links in a row.`);
		const target = posix.normalize(posix.join(posix.dirname(entry.path), entry.link_target ?? ""));
		if (target !== WORKSPACE_DIRNAME && !target.startsWith(`${WORKSPACE_DIRNAME}/`)) {
			throw new SnapshotFileError("not_found", "The link leads outside /workspace.");
		}
		const next = index.byPath.get(target);
		if (next === undefined) throw new SnapshotFileError("not_found", "The link leads to nothing in the snapshot.");
		entry = next;
	}
	return entry;
}

function payloadOf(entry: SnapshotIndexEntry): FileEntryPayload {
	return {
		name: posix.basename(entry.path),
		path: `/${entry.path}`,
		kind: entry.kind,
		size: entry.kind === "file" ? entry.size : null,
		mode: entry.mode.toString(8).padStart(3, "0"),
		sha256: entry.kind === "file" ? entry.sha256 : null,
		link_target: entry.kind === "symlink" ? entry.link_target : null,
	};
}

type OpenSnapshot = { uri: string; manifest: SnapshotManifest; index: LoadedIndex };

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

/**
 * Reads a published snapshot without opening the whole pack: the manifest names the index, the index lists every entry and
 * where each file's gzip member lives, and a file read is one ranged read of that member. It writes nothing.
 */
export class SnapshotFileService {
	private readonly store: SnapshotReadStore;

	constructor(store: SnapshotReadStore) {
		this.store = store;
	}

	/** List one directory: directories first, then by name, at most 2000 entries. */
	async list(tenantId: string, computerId: string, rawPath: string | undefined): Promise<FileListing> {
		const path = indexPathOf(rawPath);
		const snapshot = await this.open(tenantId, computerId);
		const found = snapshot.index.byPath.get(path);
		if (found === undefined) throw new SnapshotFileError("not_found", "No such path in the snapshot.");
		const directory = followSymlinks(snapshot.index, found);
		if (directory.kind !== "directory") throw new SnapshotFileError("not_a_directory", "The path is not a directory.");
		const children = [...(snapshot.index.childrenOf.get(directory.path) ?? [])].sort((left, right) => {
			const leftRank = left.kind === "directory" ? 0 : 1;
			const rightRank = right.kind === "directory" ? 0 : 1;
			if (leftRank !== rightRank) return leftRank - rightRank;
			const leftName = posix.basename(left.path);
			const rightName = posix.basename(right.path);
			return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
		});
		return {
			source: "snapshot",
			as_of: snapshot.manifest.published_at ?? null,
			path: `/${path}`,
			truncated: children.length > MAX_LISTED_ENTRIES,
			entries: children.slice(0, MAX_LISTED_ENTRIES).map(payloadOf),
		};
	}

	/** One entry, as it is, without following a symbolic link. */
	async stat(tenantId: string, computerId: string, rawPath: string | undefined): Promise<FileStat> {
		const path = indexPathOf(rawPath);
		const snapshot = await this.open(tenantId, computerId);
		const entry = snapshot.index.byPath.get(path);
		if (entry === undefined) throw new SnapshotFileError("not_found", "No such path in the snapshot.");
		return { source: "snapshot", as_of: snapshot.manifest.published_at ?? null, entry: payloadOf(entry) };
	}

	/**
	 * Read a byte range of one file. The file's gzip member is fetched with one ranged read, decompressed, and its SHA-256
	 * checked against the index before any byte is returned.
	 */
	async content(
		tenantId: string,
		computerId: string,
		rawPath: string | undefined,
		range: { offset: number; length: number },
	): Promise<FileContent> {
		const path = indexPathOf(rawPath);
		if (range.length > MAX_CONTENT_RANGE_BYTES) {
			throw new SnapshotFileError("range_too_large", `A read returns at most ${MAX_CONTENT_RANGE_BYTES} bytes.`);
		}
		let snapshot = await this.open(tenantId, computerId);
		for (let attempt = 1; ; attempt += 1) {
			try {
				return await this.readContent(snapshot, path, range);
			} catch (error) {
				if (!(error instanceof CorruptMemberError)) throw error;
				const fresh = await this.open(tenantId, computerId);
				if (attempt === 1 && fresh.manifest.checksum !== snapshot.manifest.checksum) {
					snapshot = fresh;
					continue;
				}
				console.error(formatLogLine("snapshot_member_corrupt", { tenant_id: tenantId, computer_id: computerId, path: `/${path}`, reason: error.message }));
				throw new SnapshotFileError("corrupt_snapshot", "The stored file does not match the snapshot index.");
			}
		}
	}

	private async open(tenantId: string, computerId: string): Promise<OpenSnapshot> {
		const uri = snapshotUri(tenantId, computerId, { bucket: this.store.bucket });
		let manifest: SnapshotManifest;
		try {
			manifest = await Promise.resolve(this.store.getManifest(uri));
		} catch (error) {
			if (error instanceof SnapshotObjectMissingError) throw new SnapshotFileError("no_snapshot", "This computer has not published a snapshot.");
			throw error;
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

	private async readContent(snapshot: OpenSnapshot, path: string, range: { offset: number; length: number }): Promise<FileContent> {
		const found = snapshot.index.byPath.get(path);
		if (found === undefined) throw new SnapshotFileError("not_found", "No such path in the snapshot.");
		const entry = followSymlinks(snapshot.index, found);
		if (entry.kind !== "file") throw new SnapshotFileError("not_a_file", "The path is not a file.");
		const sha256 = entry.sha256 ?? "";
		const asOf = snapshot.manifest.published_at ?? null;
		if (looksLikeSecretFile(entry.path) || looksLikeSecretFile(path)) {
			return {
				source: "snapshot",
				as_of: asOf,
				path: `/${path}`,
				size: entry.size,
				sha256,
				encoding: "utf8",
				binary: false,
				offset: range.offset,
				length: 0,
				content: "",
				truncated: false,
				masked: true,
			};
		}
		const data = await this.readVerifiedFile(snapshot, entry);
		const binary = looksBinary(data);
		const requested = data.subarray(Math.min(range.offset, data.length), Math.min(range.offset + range.length, data.length));
		const slice = binary ? requested : trimToCharacterBoundary(requested);
		return {
			source: "snapshot",
			as_of: asOf,
			path: `/${path}`,
			size: entry.size,
			sha256,
			encoding: binary ? "base64" : "utf8",
			binary,
			offset: range.offset,
			length: slice.length,
			content: binary ? slice.toString("base64") : slice.toString("utf8"),
			truncated: Math.min(range.offset, data.length) + slice.length < data.length,
			masked: false,
		};
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
