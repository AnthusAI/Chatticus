/**
 * The program that carries out one file operation for the owner, started through the unprivileged shell launcher.
 *
 * The owner process holds the organization's scoped cloud credentials and runs as root, while the model's commands run as an
 * unprivileged user that may create symbolic links in the workspace. If the owner opened the files its file tools name, a link
 * planted by a command (to its own environment, to a file the owner executes) would make the owner read or overwrite what the
 * shell could never reach. So the owner never opens them: it starts this program through the same launcher that starts
 * `run_terminal`, hands it one request on standard input, and reads one answer from standard output. Whatever a link points to,
 * the operation can touch only what the shell itself can touch. Because the privilege boundary is the user and not a test of
 * the path, a link swapped between a check and the open (a race the shell can run in the background) gains nothing.
 *
 * On top of that boundary the helper refuses any path whose final location, after following every link, is outside the
 * allowed roots. It protects what the unprivileged user can reach but the workspace should not expose, and it is what makes
 * the behavior testable on a machine where no second user exists. It is a second line; the user is the first.
 *
 * The live file operations (list, ranged read, atomic write with a precondition, mkdir, unlink, rmtree, rename) and the
 * file tools of Pi go through this one program. Every writing operation resolves the parent directory, never follows the
 * final component unless it is a write (which writes through a link), and answers with the codes of
 * `LIVE_FILE_OWNER_ERROR_CODES`.
 *
 * Only Node built-ins and the rules module of the host protocol (which imports nothing) are imported, so the image bundle of
 * this program starts quickly and cannot pull in a credential.
 */

import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, opendir, readdir, readlink, realpath, rename, rmdir, symlink, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
	LIVE_WORKSPACE_ROOT,
	livePathHasGitSegment,
	looksBinary,
	looksLikeSecretFile,
	symlinkHashOf,
	treeHashOf,
	trimToCharacterBoundary,
	type LiveTreeDescendant,
} from "@chatticus/host-protocol/live-file-rules";

/** The file operations the helper carries out. */
export type OwnerFileOperation = "read" | "write" | "stat" | "realpath" | "list" | "mkdir" | "unlink" | "rmtree" | "rename";

/** What a write must find on the disk: a file with this hash to replace, or no file at all. */
export type OwnerFileWritePrecondition = { readonly type: "if_match"; readonly sha256: string } | { readonly type: "if_none_match" };

/** One request: what to do to which path, and the directories the final location must stay inside. */
export type OwnerFileRequest = {
	readonly operation: OwnerFileOperation;
	readonly path: string;
	readonly allowedRoots: readonly string[];
	/** The bytes to write, base64 encoded; only for `write` by the Pi tools. */
	readonly contentBase64?: string;
	/** The UTF-8 text to write; only for `write` by the live file operations. */
	readonly content?: string;
	/** What a `write` must find; absent means replace or create without a check (the Pi tools). */
	readonly precondition?: OwnerFileWritePrecondition;
	/** Create the missing parent directories; the Pi tools only. */
	readonly createParents?: boolean;
	/** Refuse any path whose requested or resolved form has a `.git` segment; every live request sets it. */
	readonly refuseGitSegments?: boolean;
	/** A byte range of a file of at most `maxFileBytes`; absent means the whole file, as the Pi tools read it. */
	readonly range?: { readonly offset: number; readonly length: number; readonly maxFileBytes: number; readonly mask: boolean };
	/** The most entries a `list` returns. */
	readonly maxEntries?: number;
	/** The most names a `list` reads from the directory. */
	readonly maxScan?: number;
	/** The target of a `rename`. */
	readonly to?: string;
	/** Whether an `unlink` or `rmtree` is a recursive removal; `rmtree` requires it. */
	readonly recursive?: boolean;
	/**
	 * The effective hash an `unlink`, `rmtree` or `rename` must find: the content hash of a file, the symlink hash of a link
	 * or the tree hash of a directory. The helper decides which by what is really at the path.
	 */
	readonly sha256?: string;
	/** For `stat`: also compute the effective hash of the entry (the content hash of a file, the tree hash of a directory). */
	readonly hash?: boolean;
	/** For `stat` with `hash`: the largest file that is hashed; a larger one is `file_too_large`. */
	readonly maxFileBytes?: number;
};

/** One directory entry of a `list`. */
export type OwnerFileListEntry = {
	readonly name: string;
	readonly kind: "file" | "directory" | "symlink";
	readonly size: number | null;
	readonly mode: string;
	readonly linkTarget: string | null;
	readonly modifiedMs: number;
};

/** The fields a successful operation answers with; each operation fills the ones it has. */
export type OwnerFileSuccess = {
	readonly ok: true;
	readonly contentBase64?: string;
	readonly kind?: "file" | "directory" | "symlink" | "other";
	readonly size?: number;
	readonly mtimeMs?: number;
	readonly path?: string;
	readonly resolvedPath?: string;
	readonly entries?: readonly OwnerFileListEntry[];
	readonly sha256?: string;
	readonly sha256Before?: string | null;
	readonly treeSha256?: string;
	readonly treeSha256Before?: string | null;
	readonly modifiedMs?: number;
	readonly mode?: string;
	readonly created?: boolean;
	readonly keptAs?: string;
	readonly truncated?: boolean;
	readonly masked?: boolean;
	readonly binary?: boolean;
	readonly encoding?: "utf8" | "base64";
	readonly offset?: number;
	readonly length?: number;
	readonly content?: string;
	readonly linkTarget?: string | null;
	readonly directory?: boolean;
	readonly removed?: number;
	readonly from?: string;
	readonly to?: string;
};

/** What the helper answers: the result of the operation, or the code and message of the error that stopped it. */
export type OwnerFileResponse =
	| OwnerFileSuccess
	| { readonly ok: false; readonly code: string; readonly message: string; readonly currentSha256?: string | null };

/** Seams a test uses to put a concurrent writer inside the window the helper must survive. */
export type OwnerFileHelperHooks = {
	/** Called after the first comparison of a write and before the temporary file is made. */
	readonly afterFirstComparison?: (finalLocation: string) => Promise<void>;
	/** Called after the second comparison of a write and before the file is published. */
	readonly beforePublish?: (finalLocation: string) => Promise<void>;
	/** Called after a replaced file was published and before the replaced inode is read again. */
	readonly afterPublish?: (finalLocation: string) => Promise<void>;
	/** Called after a file was unlinked and before the removed inode is read again. */
	readonly afterUnlink?: (finalLocation: string) => Promise<void>;
};

const MAXIMUM_LINK_HOPS = 40;
const EDIT_MAXIMUM_BYTES = 262144;
const TREE_MAXIMUM_ENTRIES = 5000;
const LINK_TARGET_MAXIMUM_CHARACTERS = 4096;
const STREAM_BLOCK_BYTES = 1 << 20;
const NEW_FILE_PERMISSIONS = 0o664;
const NEW_DIRECTORY_PERMISSIONS = 0o775;
const KEPT_NAME_BYTES = 4;
const EMPTY_TREE_HASH = createHash("sha256").digest("hex");

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const errnoOf = (error: unknown): string => (error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "UNKNOWN");

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

class HelperError extends Error {
	readonly code: string;
	readonly currentSha256: string | null | undefined;

	constructor(code: string, message: string, currentSha256?: string | null) {
		super(message);
		this.code = code;
		this.currentSha256 = currentSha256;
	}
}

const CODE_OF_ERRNO: Readonly<Record<string, string>> = {
	ENOENT: "not_found",
	EACCES: "permission_denied",
	EPERM: "permission_denied",
	ENOTDIR: "not_a_directory",
	EISDIR: "not_a_file",
	EEXIST: "already_exists",
	ENOTEMPTY: "directory_not_empty",
};

function failureOf(error: unknown): OwnerFileResponse {
	if (error instanceof HelperError) {
		return { ok: false, code: error.code, message: error.message, ...(error.currentSha256 === undefined ? {} : { currentSha256: error.currentSha256 }) };
	}
	return { ok: false, code: CODE_OF_ERRNO[errnoOf(error)] ?? "io_error", message: messageOf(error) };
}

/**
 * The place a path ends at once every symbolic link on it is followed, including the links of the part that does not exist
 * yet (a dangling link is followed to where it would create a file, and a missing tail is joined to its resolved parent).
 *
 * @param path An absolute path.
 * @param hops How many links were followed so far; guards against loops of missing targets.
 * @returns The absolute location.
 */
async function finalLocationOf(path: string, hops: number = 0): Promise<string> {
	try {
		return await realpath(path);
	} catch (error) {
		const code = errnoOf(error);
		if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
		if (hops > MAXIMUM_LINK_HOPS) throw error;
		const stats = await lstat(path).catch(() => null);
		if (stats?.isSymbolicLink()) return finalLocationOf(resolve(dirname(path), await readlink(path)), hops + 1);
		const parent = dirname(path);
		if (parent === path) throw error;
		return join(await finalLocationOf(parent, hops + 1), basename(path));
	}
}

const isInside = (location: string, root: string): boolean => location === root || location.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

type Containment = {
	readonly roots: readonly string[];
	readonly workspaceRoot: string;
	readonly lexicalWorkspaceRoot: string;
	readonly refuseGitSegments: boolean;
};

async function containmentOf(request: OwnerFileRequest): Promise<Containment> {
	const roots = await Promise.all(request.allowedRoots.map((root) => finalLocationOf(root)));
	return {
		roots,
		workspaceRoot: roots[0] ?? "/",
		lexicalWorkspaceRoot: resolve(request.allowedRoots[0] ?? "/"),
		refuseGitSegments: request.refuseGitSegments === true,
	};
}

function assertLocationInside(location: string, requested: string, containment: Containment): void {
	if (!containment.roots.some((root) => isInside(location, root))) {
		throw new HelperError("outside_workspace", `The path ${requested} resolves outside the workspace, so it was not accessed.`);
	}
}

function logicalPathOf(location: string, containment: Containment): string {
	if (location === containment.workspaceRoot) return LIVE_WORKSPACE_ROOT;
	if (!isInside(location, containment.workspaceRoot)) return location;
	return `${LIVE_WORKSPACE_ROOT}/${relative(containment.workspaceRoot, location).split(sep).join("/")}`;
}

function assertNoGitSegment(requested: string, location: string, containment: Containment): void {
	if (!containment.refuseGitSegments) return;
	const lexical = isInside(requested, containment.lexicalWorkspaceRoot)
		? `${LIVE_WORKSPACE_ROOT}/${relative(containment.lexicalWorkspaceRoot, requested).split(sep).join("/")}`
		: requested;
	if (livePathHasGitSegment(lexical) || livePathHasGitSegment(logicalPathOf(location, containment))) {
		throw new HelperError("path_refused", "Paths inside a .git directory are not available here.");
	}
}

/**
 * Resolve a path the way a read or a write does: every link is followed, the final location must be inside the allowed
 * roots and, when asked, must have no `.git` segment.
 */
async function followedLocationOf(requested: string, containment: Containment): Promise<string> {
	const location = await finalLocationOf(requested);
	assertLocationInside(location, requested, containment);
	assertNoGitSegment(requested, location, containment);
	return location;
}

type UnfollowedLocation = { readonly parent: string; readonly location: string; readonly isWorkspaceRoot: boolean };

/**
 * Resolve a path the way a stat, a delete or a rename does: the parent directory is resolved and must be inside the allowed
 * roots, and the final component is never followed, so an operation on a link acts on the link.
 */
async function unfollowedLocationOf(requested: string, containment: Containment): Promise<UnfollowedLocation> {
	if (requested === containment.lexicalWorkspaceRoot) {
		return { parent: dirname(containment.workspaceRoot), location: containment.workspaceRoot, isWorkspaceRoot: true };
	}
	const parent = await finalLocationOf(dirname(requested));
	assertLocationInside(parent, requested, containment);
	const location = join(parent, basename(requested));
	assertNoGitSegment(requested, location, containment);
	return { parent, location, isWorkspaceRoot: false };
}

const kindOf = (stats: Awaited<ReturnType<typeof lstat>>): "file" | "directory" | "symlink" | "other" =>
	stats.isFile() ? "file" : stats.isDirectory() ? "directory" : stats.isSymbolicLink() ? "symlink" : "other";

const modeOf = (stats: { readonly mode: number }): string => (stats.mode & 0o777).toString(8).padStart(3, "0");

async function openRegularFile(location: string, maximumBytes: number | null): Promise<{ readonly handle: FileHandle; readonly size: number; readonly mode: number }> {
	const handle = await open(location, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const stats = await handle.stat();
		if (!stats.isFile()) throw new HelperError("not_a_file", "The path is not a regular file.");
		if (maximumBytes !== null && stats.size > maximumBytes) {
			throw new HelperError("file_too_large", `The file is ${stats.size} bytes, which is over the limit of ${maximumBytes}.`);
		}
		return { handle, size: stats.size, mode: stats.mode & 0o777 };
	} catch (error) {
		await handle.close().catch(() => undefined);
		throw error;
	}
}

async function hashOfOpenFile(handle: FileHandle): Promise<string> {
	const hash = createHash("sha256");
	const block = Buffer.alloc(STREAM_BLOCK_BYTES);
	let position = 0;
	for (;;) {
		const { bytesRead } = await handle.read(block, 0, block.length, position);
		if (bytesRead === 0) break;
		hash.update(block.subarray(0, bytesRead));
		position += bytesRead;
	}
	return hash.digest("hex");
}

async function copyOpenFile(handle: FileHandle, destination: string, permissions: number): Promise<void> {
	const output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, permissions);
	try {
		const block = Buffer.alloc(STREAM_BLOCK_BYTES);
		let position = 0;
		for (;;) {
			const { bytesRead } = await handle.read(block, 0, block.length, position);
			if (bytesRead === 0) break;
			await output.write(block, 0, bytesRead);
			position += bytesRead;
		}
		await output.sync();
	} finally {
		await output.close();
	}
}

async function hashOfPath(location: string): Promise<string> {
	const { handle } = await openRegularFile(location, null);
	try {
		return await hashOfOpenFile(handle);
	} finally {
		await handle.close();
	}
}

type TreeEntry = { readonly relativePath: string; readonly kind: "file" | "symlink" | "dir" | "other"; readonly size: number; readonly target: string };

async function walkTree(root: string): Promise<{ readonly entries: readonly TreeEntry[]; readonly treeSha256: string }> {
	const rootStats = await lstat(root);
	const entries: TreeEntry[] = [];
	const pending: Array<{ readonly directory: string; readonly prefix: string }> = [{ directory: root, prefix: "" }];
	while (pending.length > 0) {
		const { directory, prefix } = pending.pop()!;
		for (const name of await readdir(directory)) {
			const stats = await lstat(join(directory, name)).catch(() => null);
			if (stats === null) continue;
			if (entries.length >= TREE_MAXIMUM_ENTRIES) throw new HelperError("too_many_entries", `The folder holds more than ${TREE_MAXIMUM_ENTRIES} entries.`);
			const relativePath = prefix === "" ? name : `${prefix}/${name}`;
			if (stats.isDirectory()) {
				entries.push({ relativePath, kind: "dir", size: 0, target: "" });
				if (stats.dev === rootStats.dev) pending.push({ directory: join(directory, name), prefix: relativePath });
			} else if (stats.isSymbolicLink()) {
				entries.push({ relativePath, kind: "symlink", size: 0, target: await readlink(join(directory, name)) });
			} else if (stats.isFile()) {
				entries.push({ relativePath, kind: "file", size: stats.size, target: "" });
			} else {
				entries.push({ relativePath, kind: "other", size: 0, target: "" });
			}
		}
	}
	const descendants: LiveTreeDescendant[] = [];
	for (const entry of entries) {
		if (entry.kind === "file") descendants.push({ relativePath: entry.relativePath, kind: "file", size: entry.size });
		else if (entry.kind === "symlink") descendants.push({ relativePath: entry.relativePath, kind: "symlink", target: entry.target });
		else if (entry.kind === "dir") descendants.push({ relativePath: entry.relativePath, kind: "dir" });
	}
	return { entries, treeSha256: treeHashOf(descendants, sha256Hex) };
}

function opaqueKeptPath(location: string, label: "replaced" | "deleted"): string {
	return `${location}.chatticus-${label}-${randomBytes(KEPT_NAME_BYTES).toString("hex")}`;
}

async function readOperation(request: OwnerFileRequest, containment: Containment): Promise<OwnerFileResponse> {
	const requested = resolve(request.path);
	const location = await followedLocationOf(requested, containment);
	const range = request.range;
	const { handle, size, mode } = await openRegularFile(location, range === undefined ? null : range.maxFileBytes);
	try {
		const whole = await handle.readFile();
		if (range === undefined) return { ok: true, contentBase64: whole.toString("base64") };
		const resolvedPath = logicalPathOf(location, containment);
		const sha256 = sha256Hex(whole);
		const stats = await handle.stat();
		const common = { ok: true as const, resolvedPath, size, sha256, mode: mode.toString(8).padStart(3, "0"), modifiedMs: stats.mtimeMs, offset: range.offset };
		if (range.mask && (looksLikeSecretFile(resolvedPath) || looksLikeSecretFile(logicalPathOf(requested, containment)))) {
			return { ...common, encoding: "utf8", binary: false, length: 0, content: "", truncated: false, masked: true };
		}
		const binary = looksBinary(whole);
		const slice = whole.subarray(Math.min(range.offset, whole.length), Math.min(range.offset + range.length, whole.length));
		const chunk = binary ? slice : trimToCharacterBoundary(slice);
		return {
			...common,
			encoding: binary ? "base64" : "utf8",
			binary,
			length: chunk.length,
			content: binary ? Buffer.from(chunk).toString("base64") : Buffer.from(chunk).toString("utf8"),
			truncated: Math.min(range.offset, whole.length) + chunk.length < whole.length,
			masked: false,
		};
	} finally {
		await handle.close();
	}
}

async function listOperation(request: OwnerFileRequest, containment: Containment): Promise<OwnerFileResponse> {
	const requested = resolve(request.path);
	const location = await followedLocationOf(requested, containment);
	const maximumEntries = request.maxEntries ?? Number.POSITIVE_INFINITY;
	const maximumScan = request.maxScan ?? Number.POSITIVE_INFINITY;
	const directory = await opendir(location);
	const entries: OwnerFileListEntry[] = [];
	let scanned = 0;
	let truncated = false;
	for await (const item of directory) {
		if (scanned >= maximumScan) {
			truncated = true;
			break;
		}
		scanned += 1;
		const stats = await lstat(join(location, item.name)).catch(() => null);
		if (stats === null) continue;
		if (stats.isFile()) entries.push({ name: item.name, kind: "file", size: stats.size, mode: modeOf(stats), linkTarget: null, modifiedMs: stats.mtimeMs });
		else if (stats.isDirectory()) entries.push({ name: item.name, kind: "directory", size: null, mode: modeOf(stats), linkTarget: null, modifiedMs: stats.mtimeMs });
		else if (stats.isSymbolicLink()) {
			const target = (await readlink(join(location, item.name)).catch(() => "")).slice(0, LINK_TARGET_MAXIMUM_CHARACTERS);
			entries.push({ name: item.name, kind: "symlink", size: null, mode: modeOf(stats), linkTarget: target, modifiedMs: stats.mtimeMs });
		}
	}
	entries.sort((left, right) => {
		const leftRank = left.kind === "directory" ? 0 : 1;
		const rightRank = right.kind === "directory" ? 0 : 1;
		if (leftRank !== rightRank) return leftRank - rightRank;
		return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
	});
	if (entries.length > maximumEntries) truncated = true;
	return { ok: true, resolvedPath: logicalPathOf(location, containment), entries: entries.slice(0, maximumEntries), truncated };
}

async function hashOfFileWithin(location: string, maximumBytes: number | null): Promise<string> {
	const { handle } = await openRegularFile(location, maximumBytes);
	try {
		return await hashOfOpenFile(handle);
	} finally {
		await handle.close();
	}
}

async function statOperation(request: OwnerFileRequest, containment: Containment): Promise<OwnerFileResponse> {
	const requested = resolve(request.path);
	const { location } = await unfollowedLocationOf(requested, containment);
	const stats = await lstat(location);
	const kind = kindOf(stats);
	const linkTarget = kind === "symlink" ? (await readlink(location)).slice(0, LINK_TARGET_MAXIMUM_CHARACTERS) : null;
	const tree = request.hash === true && kind === "directory" ? await walkTree(location) : null;
	const contentHash = request.hash === true && kind === "file" ? await hashOfFileWithin(location, request.maxFileBytes ?? null) : null;
	return {
		ok: true,
		resolvedPath: logicalPathOf(location, containment),
		kind,
		size: stats.size,
		mtimeMs: stats.mtimeMs,
		mode: modeOf(stats),
		linkTarget,
		...(linkTarget === null ? {} : { sha256: symlinkHashOf(linkTarget, sha256Hex) }),
		...(contentHash === null ? {} : { sha256: contentHash }),
		...(tree === null ? {} : { treeSha256: tree.treeSha256 }),
	};
}

async function mkdirOperation(request: OwnerFileRequest, containment: Containment): Promise<OwnerFileResponse> {
	const requested = resolve(request.path);
	const { location, isWorkspaceRoot } = await unfollowedLocationOf(requested, containment);
	const resolvedPath = logicalPathOf(location, containment);
	if (isWorkspaceRoot) return { ok: true, resolvedPath, created: false };
	const existing = await lstat(location).catch(() => null);
	if (existing !== null) {
		if (existing.isDirectory()) return { ok: true, resolvedPath, created: false };
		throw new HelperError("already_exists", "A file or a link with that name already exists.");
	}
	try {
		await mkdir(location, { mode: NEW_DIRECTORY_PERMISSIONS });
	} catch (error) {
		if (errnoOf(error) === "ENOENT") throw new HelperError("parent_missing", "The parent directory does not exist.");
		if (errnoOf(error) === "EEXIST" && (await lstat(location).catch(() => null))?.isDirectory() === true) return { ok: true, resolvedPath, created: false };
		throw error;
	}
	return { ok: true, resolvedPath, created: true };
}

async function unlinkOperation(request: OwnerFileRequest, containment: Containment, hooks: OwnerFileHelperHooks): Promise<OwnerFileResponse> {
	const requested = resolve(request.path);
	const { location, isWorkspaceRoot } = await unfollowedLocationOf(requested, containment);
	if (isWorkspaceRoot) throw new HelperError("outside_workspace", "The workspace itself cannot be removed.");
	const resolvedPath = logicalPathOf(location, containment);
	const stats = await lstat(location);
	if (stats.isDirectory()) {
		if ((await readdir(location)).length > 0) throw new HelperError("directory_not_empty", "The folder is not empty.");
		if (request.sha256 !== EMPTY_TREE_HASH) throw new HelperError("precondition_failed", "The folder is not the one that was seen.", EMPTY_TREE_HASH);
		await rmdir(location);
		return { ok: true, resolvedPath, directory: true, removed: 1, sha256Before: null, treeSha256Before: EMPTY_TREE_HASH };
	}
	if (stats.isSymbolicLink()) {
		const current = symlinkHashOf(await readlink(location), sha256Hex);
		if (request.sha256 !== current) throw new HelperError("precondition_failed", "The link is not the one that was seen.", current);
		await unlink(location);
		return { ok: true, resolvedPath, directory: false, removed: 1, sha256Before: current, treeSha256Before: null };
	}
	const { handle, mode } = await openRegularFile(location, null);
	try {
		const current = await hashOfOpenFile(handle);
		if (request.sha256 !== current) throw new HelperError("precondition_failed", "The file is not the one that was seen.", current);
		await unlink(location);
		await hooks.afterUnlink?.(location);
		const after = await hashOfOpenFile(handle);
		let keptAs: string | undefined;
		if (after !== current) {
			const keptPath = opaqueKeptPath(location, "deleted");
			await copyOpenFile(handle, keptPath, mode);
			keptAs = logicalPathOf(keptPath, containment);
		}
		return { ok: true, resolvedPath, directory: false, removed: 1, sha256Before: current, treeSha256Before: null, ...(keptAs === undefined ? {} : { keptAs }) };
	} finally {
		await handle.close();
	}
}

async function rmtreeOperation(request: OwnerFileRequest, containment: Containment): Promise<OwnerFileResponse> {
	const requested = resolve(request.path);
	const { location, isWorkspaceRoot } = await unfollowedLocationOf(requested, containment);
	if (isWorkspaceRoot) throw new HelperError("outside_workspace", "The workspace itself cannot be removed.");
	if (request.recursive !== true) throw new HelperError("io_error", "A removal of a whole folder must say it is recursive.");
	const stats = await lstat(location);
	if (!stats.isDirectory()) throw new HelperError("not_a_directory", "The path is not a folder.");
	const { entries, treeSha256 } = await walkTree(location);
	if (request.sha256 !== treeSha256) throw new HelperError("precondition_failed", "The folder is not the one that was seen.", treeSha256);
	const deepestFirst = [...entries].sort((left, right) => right.relativePath.split("/").length - left.relativePath.split("/").length);
	for (const entry of deepestFirst) {
		const entryPath = join(location, ...entry.relativePath.split("/"));
		if (entry.kind === "dir") await rmdir(entryPath);
		else await unlink(entryPath);
	}
	await rmdir(location);
	return {
		ok: true,
		resolvedPath: logicalPathOf(location, containment),
		directory: true,
		removed: Math.min(entries.length + 1, TREE_MAXIMUM_ENTRIES),
		sha256Before: null,
		treeSha256Before: treeSha256,
	};
}

async function renameOperation(request: OwnerFileRequest, containment: Containment): Promise<OwnerFileResponse> {
	const requestedSource = resolve(request.path);
	const requestedTarget = resolve(request.to ?? "");
	const source = await unfollowedLocationOf(requestedSource, containment);
	const target = await unfollowedLocationOf(requestedTarget, containment);
	if (source.isWorkspaceRoot || target.isWorkspaceRoot) throw new HelperError("invalid_move", "The workspace itself cannot be moved.");
	const sourceStats = await lstat(source.location);
	if (isInside(target.location, source.location)) throw new HelperError("invalid_move", "A path cannot be moved into itself.");
	const targetParent = await lstat(target.parent).catch(() => null);
	if (targetParent === null) throw new HelperError("parent_missing", "The parent of the new path does not exist.");
	if (!targetParent.isDirectory()) throw new HelperError("not_a_directory", "The parent of the new path is not a folder.");
	if (targetParent.dev !== sourceStats.dev) throw new HelperError("io_error", "The new path is on another device.");
	const from = logicalPathOf(source.location, containment);
	const to = logicalPathOf(target.location, containment);
	if (sourceStats.isDirectory()) {
		const { treeSha256 } = await walkTree(source.location);
		if (request.sha256 !== treeSha256) throw new HelperError("precondition_failed", "The folder is not the one that was seen.", treeSha256);
		try {
			await mkdir(target.location, { mode: NEW_DIRECTORY_PERMISSIONS });
		} catch (error) {
			if (errnoOf(error) === "EEXIST") throw new HelperError("already_exists", "Something with that name already exists.");
			throw error;
		}
		try {
			await rename(source.location, target.location);
		} catch (error) {
			await rmdir(target.location).catch(() => undefined);
			const code = errnoOf(error);
			if (code === "ENOTEMPTY" || code === "EEXIST") throw new HelperError("already_exists", "Something with that name already exists.");
			throw error;
		}
		return { ok: true, from, to, directory: true, treeSha256 };
	}
	if (sourceStats.isSymbolicLink()) {
		const linkTarget = await readlink(source.location);
		const current = symlinkHashOf(linkTarget, sha256Hex);
		if (request.sha256 !== current) throw new HelperError("precondition_failed", "The link is not the one that was seen.", current);
		try {
			await symlink(linkTarget, target.location);
		} catch (error) {
			if (errnoOf(error) === "EEXIST") throw new HelperError("already_exists", "Something with that name already exists.");
			throw error;
		}
		await unlink(source.location);
		return { ok: true, from, to, directory: false, sha256: current };
	}
	const { handle } = await openRegularFile(source.location, null);
	try {
		const current = await hashOfOpenFile(handle);
		if (request.sha256 !== current) throw new HelperError("precondition_failed", "The file is not the one that was seen.", current);
		try {
			await link(source.location, target.location);
		} catch (error) {
			if (errnoOf(error) === "EEXIST") throw new HelperError("already_exists", "Something with that name already exists.");
			throw error;
		}
		await unlink(source.location);
		return { ok: true, from, to, directory: false, sha256: current };
	} finally {
		await handle.close();
	}
}

async function writeOperation(request: OwnerFileRequest, containment: Containment, hooks: OwnerFileHelperHooks): Promise<OwnerFileResponse> {
	const requested = resolve(request.path);
	let location = await followedLocationOf(requested, containment);
	const bytes = request.content === undefined ? Buffer.from(request.contentBase64 ?? "", "base64") : Buffer.from(request.content, "utf8");
	if (request.content !== undefined) {
		if (request.content.includes("\u0000")) throw new HelperError("not_text", "The content is not text.");
		if (bytes.length > EDIT_MAXIMUM_BYTES) throw new HelperError("file_too_large", `The content is over ${EDIT_MAXIMUM_BYTES} bytes.`);
	}
	const precondition = request.precondition;
	if (request.createParents === true) {
		await mkdir(dirname(location), { recursive: true });
		location = await followedLocationOf(requested, containment);
	}
	const directory = dirname(location);
	const directoryStats = await lstat(directory).catch(() => null);
	if (directoryStats === null) throw new HelperError("parent_missing", "The parent directory does not exist.");
	if (!directoryStats.isDirectory()) throw new HelperError("not_a_directory", "The parent is not a directory.");
	const existing = await lstat(location).catch(() => null);
	if (precondition?.type === "if_none_match" && existing !== null) throw new HelperError("already_exists", "A file with that name already exists.");
	if (existing !== null && !existing.isFile()) throw new HelperError("not_a_file", "The path is not a regular file.");
	let held: FileHandle | null = null;
	let hashBefore: string | null = null;
	let permissions = existing === null ? NEW_FILE_PERMISSIONS : existing.mode & 0o777;
	try {
		if (precondition?.type === "if_match") {
			const opened = await openRegularFile(location, EDIT_MAXIMUM_BYTES);
			held = opened.handle;
			permissions = opened.mode;
			hashBefore = sha256Hex(await held.readFile());
			if (hashBefore !== precondition.sha256) throw new HelperError("precondition_failed", "The file is not the one that was seen.", hashBefore);
		}
		await hooks.afterFirstComparison?.(location);
		const temporaryPath = join(directory, `.${basename(location)}.chatticus-${randomBytes(16).toString("hex")}.tmp`);
		const temporary = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		try {
			await temporary.write(bytes, 0, bytes.length, 0);
			await temporary.sync();
			await temporary.chmod(permissions);
		} catch (error) {
			await temporary.close().catch(() => undefined);
			await unlink(temporaryPath).catch(() => undefined);
			throw error;
		}
		await temporary.close();
		try {
			if (precondition?.type === "if_match") {
				const now = await hashOfPath(location).catch((error: unknown) => {
					if (errnoOf(error) === "ENOENT") throw new HelperError("not_found", "The file was removed.");
					throw error;
				});
				if (now !== precondition.sha256) throw new HelperError("precondition_failed", "The file is not the one that was seen.", now);
			} else if (precondition?.type === "if_none_match" && (await lstat(location).catch(() => null)) !== null) {
				throw new HelperError("already_exists", "A file with that name already exists.");
			}
			await hooks.beforePublish?.(location);
			if (precondition?.type === "if_none_match") {
				try {
					await link(temporaryPath, location);
				} catch (error) {
					if (errnoOf(error) === "EEXIST") throw new HelperError("already_exists", "A file with that name already exists.");
					throw error;
				}
				await unlink(temporaryPath);
			} else {
				await rename(temporaryPath, location);
			}
		} catch (error) {
			await unlink(temporaryPath).catch(() => undefined);
			throw error;
		}
		let keptAs: string | undefined;
		if (held !== null && hashBefore !== null) {
			await hooks.afterPublish?.(location);
			const replaced = await hashOfOpenFile(held);
			if (replaced !== hashBefore) {
				const keptPath = opaqueKeptPath(location, "replaced");
				await copyOpenFile(held, keptPath, permissions);
				keptAs = logicalPathOf(keptPath, containment);
			}
		}
		const written = await lstat(location);
		return {
			ok: true,
			resolvedPath: logicalPathOf(location, containment),
			created: existing === null,
			size: bytes.length,
			sha256Before: hashBefore,
			sha256: sha256Hex(bytes),
			modifiedMs: written.mtimeMs,
			...(keptAs === undefined ? {} : { keptAs }),
		};
	} finally {
		await held?.close();
	}
}

/**
 * Carry out one request with the privileges of this process.
 *
 * @param request The operation, the absolute path and the allowed roots.
 * @param hooks Seams for tests that need a concurrent writer inside the window between a check and a publish.
 * @returns The answer; an error is an answer, never a throw.
 */
export async function runOwnerFileRequest(request: OwnerFileRequest, hooks: OwnerFileHelperHooks = {}): Promise<OwnerFileResponse> {
	try {
		const containment = await containmentOf(request);
		switch (request.operation) {
			case "stat":
				return await statOperation(request, containment);
			case "realpath": {
				const requested = resolve(request.path);
				await followedLocationOf(requested, containment);
				return { ok: true, path: await realpath(requested) };
			}
			case "read":
				return await readOperation(request, containment);
			case "list":
				return await listOperation(request, containment);
			case "write":
				return await writeOperation(request, containment, hooks);
			case "mkdir":
				return await mkdirOperation(request, containment);
			case "unlink":
				return await unlinkOperation(request, containment, hooks);
			case "rmtree":
				return await rmtreeOperation(request, containment);
			case "rename":
				return await renameOperation(request, containment);
			default:
				return { ok: false, code: "io_error", message: "The file helper does not know that operation." };
		}
	} catch (error) {
		return failureOf(error);
	}
}

const readStandardInput = async (): Promise<string> => {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
	return Buffer.concat(chunks).toString("utf8");
};

/**
 * Read one request from standard input, carry it out and write the answer to standard output.
 *
 * @returns The process exit code: 0 when an answer was written, 2 when the request could not be read.
 */
export async function runOwnerFileHelperFromStandardStreams(): Promise<number> {
	let request: OwnerFileRequest;
	try {
		request = JSON.parse(await readStandardInput()) as OwnerFileRequest;
	} catch {
		process.stderr.write("The file helper could not read its request.\n");
		return 2;
	}
	process.stdout.write(JSON.stringify(await runOwnerFileRequest(request)));
	return 0;
}
