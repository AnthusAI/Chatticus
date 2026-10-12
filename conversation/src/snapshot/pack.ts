import { posix, resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { Readable, pipeline } from "node:stream";
import { promisify } from "node:util";
import zlib from "node:zlib";
import * as tar from "tar";
import { constants, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { BROWSER_PROFILES_DIRNAME, WORKSPACE_DIRNAME, ensureBrowserProfilesLayout } from "../browser-profiles.ts";
import { PACK_EXCLUDED_DIRECTORY_NAMES, PACK_MAX_FILE_BYTES } from "./exclusions.ts";
import type { SnapshotEntryKind, SnapshotIndex, SnapshotIndexEntry } from "./index-format.ts";

export const CACHE_CHECKSUM_FILENAME = ".chatticus-snapshot-checksum";

const ALLOWED_ROOTS = new Set([WORKSPACE_DIRNAME, BROWSER_PROFILES_DIRNAME]);

/** The user and group the image gives the unprivileged shell and the workspace; a restore run as root hands the tree to them. */
export const RESTORED_TREE_OWNER = { uid: 2000, gid: 2001 } as const;

const REGULAR_FILE_TYPES: ReadonlySet<string> = new Set(["File", "OldFile", "ContiguousFile"]);

/**
 * Whether a symbolic link may live in a pack: its target is relative and, resolved from the link's own directory, stays
 * inside the workspace or browser profile tree the link is in. An absolute target, a target that climbs out, and an empty
 * one are not. The check is exact because a pack accepts no entry beneath a symbolic link, so the link's directory is real.
 *
 * @param memberName The link's own path in the pack.
 * @param linkTarget What the link points to.
 * @returns Whether the link is safe to restore.
 */
export function isSafePackSymlink(memberName: string, linkTarget: string): boolean {
	if (linkTarget === "" || linkTarget.startsWith("/") || linkTarget.includes("\\")) return false;
	const resolved = posix.normalize(posix.join(posix.dirname(memberName), linkTarget));
	if (resolved === ".." || resolved.startsWith("../") || resolved.startsWith("/")) return false;
	const root = resolved.split("/")[0] ?? "";
	return ALLOWED_ROOTS.has(root) && posix.dirname(memberName).split("/")[0] === root;
}

/**
 * The snapshot pack is missing, corrupt, or unsafe to extract.
 */
export class SnapshotPackError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SnapshotPackError";
	}
}

/**
 * An object the snapshot needs is not in the store.
 */
export class SnapshotObjectMissingError extends SnapshotPackError {
	constructor(message: string) {
		super(message);
		this.name = "SnapshotObjectMissingError";
	}
}

/**
 * Return the SHA-256 hex digest of a snapshot pack.
 */
export function packChecksum(pack: Buffer): string {
	return createHash("sha256").update(pack).digest("hex");
}

const NORMALIZED_MTIME = new Date(0);

const TAR_TYPE_OF_KIND = { file: "File", directory: "Directory", symlink: "SymbolicLink" } as const;

const TAR_BLOCK_BYTES = 512;

const SMALL_FILE_BYTES = 256 * 1024;

const gzipAsync = promisify(zlib.gzip);

/** One thing on the live disk the pack would carry, as the walk saw it. */
export interface LiveDiskMember {
	path: string;
	kind: SnapshotEntryKind;
	size: number;
	mode: number;
	mtime_ms: number;
	link_target: string | null;
}

/** What a pack or a scan reports about itself while it runs. */
export interface PackOptions {
	/** Called with the path and size of each file left out because it is larger than the single-file limit. */
	onSkippedFile?: (path: string, sizeBytes: number) => void;
}

/**
 * Walk every path under the pack roots, directories before their contents, each directory in sorted order.
 *
 * Directory listing order depends on the filesystem, so the pack takes the order from this walk instead. Excluded
 * directory names, files over the single-file limit, devices, pipes, sockets, and links that are absolute or climb out
 * are left out.
 *
 * @param liveRoot The live-disk root.
 * @param options Receives each skipped oversized file.
 * @returns The members in pack order.
 */
export function walkLiveDisk(liveRoot: string, options: PackOptions = {}): LiveDiskMember[] {
	const resolvedRoot = resolve(liveRoot);
	const members: LiveDiskMember[] = [];
	const visit = (relative: string): void => {
		const stats = lstatSync(join(resolvedRoot, relative));
		const name = posix.basename(relative);
		if (stats.isSymbolicLink()) {
			const target = readlinkSync(join(resolvedRoot, relative));
			if (PACK_EXCLUDED_DIRECTORY_NAMES.has(name) || !isSafePackSymlink(relative, target)) return;
			members.push({ path: relative, kind: "symlink", size: 0, mode: 0o777, mtime_ms: Math.floor(stats.mtimeMs), link_target: target });
			return;
		}
		if (stats.isDirectory()) {
			if (PACK_EXCLUDED_DIRECTORY_NAMES.has(name)) return;
			members.push({ path: relative, kind: "directory", size: 0, mode: stats.mode & 0o777, mtime_ms: Math.floor(stats.mtimeMs), link_target: null });
			for (const child of readdirSync(join(resolvedRoot, relative)).sort()) {
				visit(`${relative}/${child}`);
			}
			return;
		}
		if (!stats.isFile()) return;
		if (stats.size > PACK_MAX_FILE_BYTES) {
			options.onSkippedFile?.(relative, stats.size);
			return;
		}
		members.push({ path: relative, kind: "file", size: stats.size, mode: stats.mode & 0o777, mtime_ms: Math.floor(stats.mtimeMs), link_target: null });
	};
	for (const root of [WORKSPACE_DIRNAME, BROWSER_PROFILES_DIRNAME]) {
		visit(root);
	}
	return members;
}

function encodeTarHeader(member: LiveDiskMember): Buffer {
	const path = member.kind === "directory" ? `${member.path}/` : member.path;
	const header = new tar.Header({
		path,
		mode: member.mode,
		uid: 0,
		gid: 0,
		uname: "",
		gname: "",
		size: member.kind === "file" ? member.size : 0,
		mtime: NORMALIZED_MTIME,
		type: TAR_TYPE_OF_KIND[member.kind],
		...(member.link_target === null ? {} : { linkpath: member.link_target }),
	});
	const needsExtendedHeader = header.encode();
	const block = header.block;
	if (block === undefined) throw new SnapshotPackError(`Could not encode a tar header for ${JSON.stringify(member.path)}.`);
	if (!needsExtendedHeader) return block;
	const extended = new tar.Pax({
		path,
		size: member.kind === "file" ? member.size : 0,
		...(member.link_target === null ? {} : { linkpath: member.link_target }),
	}).encode();
	return Buffer.concat([extended, block]);
}

function paddingFor(size: number): Buffer {
	const remainder = size % TAR_BLOCK_BYTES;
	return Buffer.alloc(remainder === 0 ? 0 : TAR_BLOCK_BYTES - remainder);
}

async function* gzipMember(parts: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
	const gzip = zlib.createGzip();
	pipeline(Readable.from(parts), gzip, () => undefined);
	for await (const chunk of gzip) {
		yield chunk as Buffer;
	}
}

async function* oneChunk(chunk: Promise<Buffer>): AsyncGenerator<Buffer> {
	yield await chunk;
}

type FileMemberOutcome = { skipped: true } | { skipped: false; member: LiveDiskMember; sha256: string };

async function* fileMemberChunks(
	root: string,
	walked: LiveDiskMember,
	outcome: { value: FileMemberOutcome },
): AsyncGenerator<Buffer> {
	let handle;
	try {
		handle = await open(join(root, walked.path), constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch {
		outcome.value = { skipped: true };
		return;
	}
	try {
		const stats = await handle.stat();
		if (!stats.isFile() || stats.size > PACK_MAX_FILE_BYTES) {
			outcome.value = { skipped: true };
			return;
		}
		const member: LiveDiskMember = { ...walked, size: stats.size, mode: stats.mode & 0o777, mtime_ms: Math.floor(stats.mtimeMs) };
		const header = encodeTarHeader(member);
		const padding = paddingFor(member.size);
		const hash = createHash("sha256");
		if (member.size <= SMALL_FILE_BYTES) {
			const data = Buffer.alloc(member.size);
			let filled = 0;
			while (filled < member.size) {
				const { bytesRead } = await handle.read(data, filled, member.size - filled, filled);
				if (bytesRead === 0) break;
				filled += bytesRead;
			}
			hash.update(data);
			outcome.value = { skipped: false, member, sha256: hash.digest("hex") };
			yield await gzipAsync(Buffer.concat([header, data, padding]));
			return;
		}
		const raw = async function* (): AsyncGenerator<Buffer> {
			yield header;
			let delivered = 0;
			if (member.size > 0) {
				for await (const chunk of handle.createReadStream({ start: 0, end: member.size - 1, autoClose: false })) {
					const part = chunk as Buffer;
					hash.update(part);
					delivered += part.length;
					yield part;
				}
			}
			if (delivered < member.size) {
				const missing = Buffer.alloc(member.size - delivered);
				hash.update(missing);
				yield missing;
			}
			yield padding;
			outcome.value = { skipped: false, member, sha256: hash.digest("hex") };
		};
		yield* gzipMember(raw());
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/** The finished facts about a pack, known once all its bytes have been produced. */
export interface LivePackResult {
	checksum: string;
	index: SnapshotIndex;
}

/** A pack being produced as a stream of bytes, with its checksum and index once the stream has ended. */
export interface LivePackStream {
	/** The bytes of the `.tar.gz`, one chunk at a time. Consume it fully before calling `result`. */
	chunks: AsyncIterable<Buffer>;
	/** The checksum and index; throws until `chunks` has been consumed to its end. */
	result(): LivePackResult;
}

/**
 * Produce the gzip-compressed tar of workspace and browser profiles as a stream.
 *
 * Every file is its own gzip member inside the one tar stream, so a reader can fetch a single file with a ranged read while
 * the whole stream remains a valid `.tar.gz`. Peak memory does not depend on the size of the disk: a file is read in
 * chunks and the bytes are handed on as they are produced. Only regular files, directories and symbolic links that stay
 * inside their tree are packed; a file with several names is stored once per name. Empty directories are included so
 * hydrate always replaces both trees. The bytes depend only on paths, file content and permission bits: members are
 * sorted, modification times are fixed, ownership is dropped, and the gzip header carries no timestamp, so an unchanged
 * disk yields an unchanged checksum.
 *
 * @param liveRoot The live-disk root.
 * @param options Receives each oversized file that is left out.
 */
export function streamLiveDisk(liveRoot: string, options: PackOptions = {}): LivePackStream {
	const resolvedRoot = resolve(liveRoot);
	mkdirSync(resolvedRoot, { recursive: true });
	ensureBrowserProfilesLayout(resolvedRoot);
	let finished: LivePackResult | null = null;

	const generate = async function* (): AsyncGenerator<Buffer> {
		const packHash = createHash("sha256");
		const entries: SnapshotIndexEntry[] = [];
		let position = 0;
		const emit = async function* (source: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
			for await (const chunk of source) {
				packHash.update(chunk);
				position += chunk.length;
				yield chunk;
			}
		};
		for (const walked of walkLiveDisk(resolvedRoot, options)) {
			const start = position;
			if (walked.kind !== "file") {
				yield* emit(oneChunk(gzipAsync(encodeTarHeader(walked))));
				entries.push({ ...walked, sha256: null, offset: null, length: null });
				continue;
			}
			const outcome: { value: FileMemberOutcome } = { value: { skipped: true } };
			yield* emit(fileMemberChunks(resolvedRoot, walked, outcome));
			if (outcome.value.skipped) continue;
			const { member, sha256 } = outcome.value;
			entries.push({ ...member, sha256, offset: start, length: position - start });
		}
		yield* emit(oneChunk(gzipAsync(Buffer.alloc(TAR_BLOCK_BYTES * 2))));
		const checksum = packHash.digest("hex");
		finished = { checksum, index: { version: 2, pack_checksum: checksum, pack_bytes: position, entries } };
	};

	return {
		chunks: generate(),
		result: () => {
			if (finished === null) throw new SnapshotPackError("The pack stream has not been consumed to its end.");
			return finished;
		},
	};
}

/**
 * Pack the live disk into memory with its checksum and index. The whole archive is held in memory, so this is for tests
 * and small tools; the publish path streams.
 */
export async function packLiveDiskWithIndex(liveRoot: string, options: PackOptions = {}): Promise<{ pack: Buffer } & LivePackResult> {
	const stream = streamLiveDisk(liveRoot, options);
	const chunks: Buffer[] = [];
	for await (const chunk of stream.chunks) {
		chunks.push(chunk);
	}
	return { pack: Buffer.concat(chunks), ...stream.result() };
}

/** Pack the live disk into memory; see `packLiveDiskWithIndex`. */
export async function packLiveDisk(liveRoot: string, options: PackOptions = {}): Promise<Buffer> {
	return (await packLiveDiskWithIndex(liveRoot, options)).pack;
}

/**
 * Replace workspace and browser profile from a snapshot pack.
 *
 * Existing trees are removed first so stale files do not survive a
 * relocate onto this host. The pack is untrusted: it is made from a tree the model's commands controlled. Only regular
 * files, directories, safe symbolic links (see `isSafePackSymlink`) and hard links to a regular file stored earlier in the same
 * pack are accepted, and no entry may lie beneath a link.
 * Extraction drops the setuid, setgid and sticky bits and does not apply the owner the archive names; run as root it gives
 * the tree to the unprivileged workspace user and group.
 */
export async function unpackLiveDisk(pack: Buffer, liveRoot: string): Promise<void> {
	const resolvedRoot = resolve(liveRoot);
	mkdirSync(resolvedRoot, { recursive: true });
	await assertPackMembersAreSafe(pack);

	for (const dirname of [WORKSPACE_DIRNAME, BROWSER_PROFILES_DIRNAME]) {
		const target = join(resolvedRoot, dirname);
		if (existsSync(target)) {
			rmSync(target, { recursive: true, force: true });
		}
	}

	return new Promise((resolve, reject) => {
		const readable = Readable.from(pack);
		const gunzip = zlib.createGunzip();
		const runningAsRoot = process.getuid?.() === 0;
		const extractStream = tar.extract({
			cwd: resolvedRoot,
			strict: true,
			...(runningAsRoot ? RESTORED_TREE_OWNER : { preserveOwner: false }),
			filter: (_path, entry) => {
				if ("mode" in entry && typeof entry.mode === "number") entry.mode = entry.mode & 0o777;
				return true;
			},
		});

		readable
			.pipe(gunzip)
			.pipe(extractStream)
			.on("end", () => {
				ensureBrowserProfilesLayout(resolvedRoot);
				resolve();
			})
			.on("error", reject);
	});
}

/**
 * Check that all members in the pack are safe to extract.
 */
async function assertPackMembersAreSafe(pack: Buffer): Promise<void> {
	const members: { name: string; type: string; linkpath: string }[] = [];
	const earlierFiles = new Set<string>();

	return new Promise((resolve, reject) => {
		const readable = Readable.from(pack);
		const gunzip = zlib.createGunzip();
		const listStream = tar.list();

		listStream.on("entry", (entry: { path?: string; type?: string; linkpath?: string }) => {
			if (entry.path) {
				members.push({ name: entry.path, type: entry.type ?? "", linkpath: entry.linkpath ?? "" });
			}
		});

		readable.pipe(gunzip).pipe(listStream);

		listStream.on("end", () => {
			if (members.length === 0) {
				reject(new SnapshotPackError("Snapshot pack contains no members."));
				return;
			}

			const normalizedOf = (memberName: string): string => memberName.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
			const linkNames = new Set<string>();
			for (const member of members) {
				if (member.type === "SymbolicLink") linkNames.add(normalizedOf(member.name));
			}

			for (const member of members) {
				const normalized = normalizedOf(member.name);
				if (!isAllowedMemberName(normalized)) {
					reject(
						new SnapshotPackError(
							`Snapshot pack contains a path outside the live disk: ${JSON.stringify(member.name)}.`
						)
					);
					return;
				}
				const isFileOrDirectory = REGULAR_FILE_TYPES.has(member.type) || member.type === "Directory";
				if (!isFileOrDirectory && member.type !== "SymbolicLink" && member.type !== "Link") {
					reject(new SnapshotPackError(`Snapshot pack contains a ${member.type} entry, which is not a file, directory or link: ${JSON.stringify(member.name)}.`));
					return;
				}
				if (member.type === "SymbolicLink" && !isSafePackSymlink(normalized, member.linkpath)) {
					reject(new SnapshotPackError(`Snapshot pack contains a link that is absolute or leaves its tree: ${JSON.stringify(member.name)}.`));
					return;
				}
				if (member.type === "Link") {
					const target = posix.normalize(normalizedOf(member.linkpath));
					if (!earlierFiles.has(target)) {
						reject(new SnapshotPackError(`Snapshot pack contains a hard link to something that is not a file stored earlier in the pack: ${JSON.stringify(member.name)}.`));
						return;
					}
				}
				if (REGULAR_FILE_TYPES.has(member.type)) earlierFiles.add(normalized);
				const parts = normalized.split("/");
				for (let length = 1; length < parts.length; length += 1) {
					if (linkNames.has(parts.slice(0, length).join("/"))) {
						reject(new SnapshotPackError(`Snapshot pack contains an entry beneath a link: ${JSON.stringify(member.name)}.`));
						return;
					}
				}
			}

			resolve();
		});

		listStream.on("error", reject);
	});
}

/**
 * Check if a tar member name is safe to extract.
 */
function isAllowedMemberName(name: string): boolean {
	if (!name || name.startsWith("/")) {
		return false;
	}

	const parts = name.split("/");
	if (parts.some((part) => part === "..")) {
		return false;
	}

	const root = parts[0];
	return ALLOWED_ROOTS.has(root);
}
