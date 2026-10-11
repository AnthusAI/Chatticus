import { posix, resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { Readable, PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import * as tar from "tar";
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { BROWSER_PROFILES_DIRNAME, WORKSPACE_DIRNAME, ensureBrowserProfilesLayout } from "../browser-profiles.ts";

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
 * Return the SHA-256 hex digest of a snapshot pack.
 */
export function packChecksum(pack: Buffer): string {
	return createHash("sha256").update(pack).digest("hex");
}

const NORMALIZED_MTIME = new Date(0);

/**
 * List every path under the given roots, directories before their contents, each directory in sorted order.
 *
 * Directory listing order depends on the filesystem, so the pack takes the order from this walk instead.
 */
function sortedPackMembers(resolvedRoot: string, roots: readonly string[]): string[] {
	const members: string[] = [];
	const visit = (relative: string): void => {
		const absolute = join(resolvedRoot, relative);
		const stats = lstatSync(absolute);
		if (stats.isSymbolicLink()) {
			if (isSafePackSymlink(relative, readlinkSync(absolute))) members.push(relative);
			return;
		}
		if (!stats.isDirectory() && !stats.isFile()) {
			return;
		}
		members.push(relative);
		if (!stats.isDirectory()) {
			return;
		}
		for (const name of readdirSync(absolute).sort()) {
			visit(`${relative}/${name}`);
		}
	};
	for (const root of roots) {
		visit(root);
	}
	return members;
}

/**
 * Create a gzip-compressed tar of workspace and browser profiles.
 *
 * Only regular files, directories and symbolic links that stay inside their tree are packed: a device, a named pipe, a socket
 * and a link that is absolute or climbs out are left out, so a pack never holds an entry the restore refuses. A file with
 * several names is stored once and linked by the others, which the restore accepts. Empty directories are included so hydrate always replaces both trees. The bytes depend only on paths, file content
 * and permission bits: members are sorted, modification times are fixed, ownership and access times are dropped, and
 * the gzip header carries no timestamp. Packing an unchanged disk therefore yields an unchanged checksum.
 */
export async function packLiveDisk(liveRoot: string): Promise<Buffer> {
	const resolvedRoot = resolve(liveRoot);
	mkdirSync(resolvedRoot, { recursive: true });
	ensureBrowserProfilesLayout(resolvedRoot);

	const chunks: Buffer[] = [];

	return new Promise((resolve, reject) => {
		const tarStream = tar.create(
			{
				gzip: true,
				cwd: resolvedRoot,
				strict: true,
				portable: true,
				noDirRecurse: true,
				mtime: NORMALIZED_MTIME,
			},
			sortedPackMembers(resolvedRoot, [WORKSPACE_DIRNAME, BROWSER_PROFILES_DIRNAME])
		);

		tarStream.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
		});

		tarStream.on("end", () => {
			resolve(Buffer.concat(chunks));
		});

		tarStream.on("error", reject);
	});
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
