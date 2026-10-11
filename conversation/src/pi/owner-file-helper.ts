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
 * Only Node built-ins are imported, so the image bundle of this program starts quickly and cannot pull in a credential.
 */

import { lstat, mkdir, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

/** The file operations the helper carries out. */
export type OwnerFileOperation = "read" | "write" | "stat" | "realpath";

/** One request: what to do to which path, and the directories the final location must stay inside. */
export type OwnerFileRequest = {
	readonly operation: OwnerFileOperation;
	readonly path: string;
	readonly allowedRoots: readonly string[];
	/** The bytes to write, base64 encoded; only for `write`. */
	readonly contentBase64?: string;
};

/** The error code the helper answers with when a path leads outside the allowed roots. */
export const OUTSIDE_ALLOWED_ROOTS_CODE = "CHATTICUS_OUTSIDE_WORKSPACE";

/** What the helper answers: the result of the operation, or the code and message of the error that stopped it. */
export type OwnerFileResponse =
	| {
			readonly ok: true;
			readonly contentBase64?: string;
			readonly kind?: "file" | "directory" | "symlink" | "other";
			readonly size?: number;
			readonly mtimeMs?: number;
			readonly path?: string;
	  }
	| { readonly ok: false; readonly code: string; readonly message: string };

const MAXIMUM_LINK_HOPS = 40;

const codeOf = (error: unknown): string => (error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "UNKNOWN");

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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
		const code = codeOf(error);
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

class OutsideAllowedRootsError extends Error {
	readonly code = OUTSIDE_ALLOWED_ROOTS_CODE;
}

async function assertInsideAllowedRoots(path: string, roots: readonly string[]): Promise<void> {
	const location = await finalLocationOf(path);
	const resolvedRoots = await Promise.all(roots.map((root) => finalLocationOf(root)));
	if (!resolvedRoots.some((root) => isInside(location, root))) {
		throw new OutsideAllowedRootsError(`The path ${path} resolves outside the workspace, so it was not accessed.`);
	}
}

const kindOf = (stats: Awaited<ReturnType<typeof lstat>>): "file" | "directory" | "symlink" | "other" =>
	stats.isFile() ? "file" : stats.isDirectory() ? "directory" : stats.isSymbolicLink() ? "symlink" : "other";

/**
 * Carry out one request with the privileges of this process.
 *
 * @param request The operation, the absolute path and the allowed roots.
 * @returns The answer; an error is an answer, never a throw.
 */
export async function runOwnerFileRequest(request: OwnerFileRequest): Promise<OwnerFileResponse> {
	const path = resolve(request.path);
	try {
		if (request.operation === "stat") {
			await assertInsideAllowedRoots(dirname(path), request.allowedRoots);
			const stats = await lstat(path);
			return { ok: true, kind: kindOf(stats), size: stats.size, mtimeMs: stats.mtimeMs };
		}
		await assertInsideAllowedRoots(path, request.allowedRoots);
		if (request.operation === "realpath") return { ok: true, path: await realpath(path) };
		if (request.operation === "read") return { ok: true, contentBase64: (await readFile(path)).toString("base64") };
		await mkdir(dirname(path), { recursive: true });
		await assertInsideAllowedRoots(path, request.allowedRoots);
		await writeFile(path, Buffer.from(request.contentBase64 ?? "", "base64"));
		return { ok: true };
	} catch (error) {
		return { ok: false, code: codeOf(error), message: messageOf(error) };
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
