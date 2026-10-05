import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { Readable, PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import * as tar from "tar";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { BROWSER_PROFILES_DIRNAME, WORKSPACE_DIRNAME, ensureBrowserProfilesLayout } from "../browser-profiles.ts";

export const CACHE_CHECKSUM_FILENAME = ".chatticus-snapshot-checksum";

const ALLOWED_ROOTS = new Set([WORKSPACE_DIRNAME, BROWSER_PROFILES_DIRNAME]);

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

/**
 * Create a gzip-compressed tar of workspace and browser profiles.
 *
 * Empty directories are included so hydrate always replaces both trees.
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
			},
			[WORKSPACE_DIRNAME, BROWSER_PROFILES_DIRNAME]
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
 * relocate onto this host.
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
		const extractStream = tar.extract({
			cwd: resolvedRoot,
			strict: true,
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
	const members: string[] = [];

	return new Promise((resolve, reject) => {
		const readable = Readable.from(pack);
		const gunzip = zlib.createGunzip();
		const listStream = tar.list();

		listStream.on("entry", (entry: { path?: string }) => {
			if (entry.path) {
				members.push(entry.path);
			}
		});

		readable.pipe(gunzip).pipe(listStream);

		listStream.on("end", () => {
			if (members.length === 0) {
				reject(new SnapshotPackError("Snapshot pack contains no members."));
				return;
			}

			for (const memberName of members) {
				const normalized = memberName.replace(/\\/g, "/").replace(/^\.\//, "");
				if (!isAllowedMemberName(normalized)) {
					reject(
						new SnapshotPackError(
							`Snapshot pack contains a path outside the live disk: ${JSON.stringify(memberName)}.`
						)
					);
					return;
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
