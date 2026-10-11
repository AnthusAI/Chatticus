/**
 * An execution environment whose file operations are carried out by a helper process started through the unprivileged shell
 * launcher, so the owner process (root, holding the organization's scoped credentials) never opens a path the model chose.
 *
 * Why this design: the file tools run in the owner, and the model's shell may plant symbolic links in the workspace. A link to
 * the owner's own environment or to a file the owner executes would turn `read_workspace` and `write_workspace` into a way to
 * read the credentials or run code with them. Checking the path (`realpath` before open) is not enough, because the shell can
 * keep a background process swapping the link between the check and the open. Doing the operation as the shell's own user
 * leaves nothing to race: whatever a link leads to, the operation can reach only what the shell can already reach. The helper
 * additionally refuses a final location outside the workspace (see `owner-file-helper.ts`).
 *
 * Only the operations the file tools use (`read`, `write`, `edit`: read bytes, read text, write, `lstat`, canonical path) are
 * implemented, each as one helper process with one request. The other file operations of the interface answer
 * `not_supported`, so a future tool cannot reach the disk through the owner by accident. `exec` is unchanged; it already
 * starts the command through the launcher.
 */

import { spawn } from "node:child_process";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord";
import { type FileErrorCode, type FileInfo, type Result, FileError, err, ok } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { OUTSIDE_ALLOWED_ROOTS_CODE, type OwnerFileRequest, type OwnerFileResponse } from "./owner-file-helper.ts";

/** Where the helper program lives when the owner runs from source: next to this module. */
export const SOURCE_FILE_HELPER_COMMAND: readonly string[] = [process.execPath, fileURLToPath(new URL("./owner-file-helper-main.ts", import.meta.url))];

/** How the file operations are carried out. */
export type UnprivilegedExecutionEnvOptions = {
	/** The workspace directory; the working directory of the helper and the only root its operations may end in. */
	readonly cwd: string;
	/** The launcher the helper is started through, called as `<launcher> -c 'exec "$@"' <name> <helper command...>`. */
	readonly launcherPath: string;
	/** The program and arguments that run the helper, by absolute path. */
	readonly helperCommand: readonly string[];
	/** The environment the helper gets; none of the owner's. */
	readonly helperEnvironment: Record<string, string>;
	/** The directories an operation's final location must stay inside; the workspace when absent. */
	readonly allowedRoots?: readonly string[];
};

const CODES: Readonly<Record<string, FileErrorCode>> = {
	ENOENT: "not_found",
	EACCES: "permission_denied",
	EPERM: "permission_denied",
	[OUTSIDE_ALLOWED_ROOTS_CODE]: "permission_denied",
	ENOTDIR: "not_directory",
	EISDIR: "is_directory",
	EINVAL: "invalid",
	ABORT_ERR: "aborted",
};

const NOT_SUPPORTED_MESSAGE = "This operation is not available on the owner: only the file tools' reads, writes and stats are carried out, and by the unprivileged helper.";

/** The Pi execution environment of an owner whose files are touched only with the shell's privileges. */
export class UnprivilegedExecutionEnv extends NodeExecutionEnv {
	private readonly launcherPath: string;
	private readonly helperCommand: readonly string[];
	private readonly helperEnvironment: Record<string, string>;
	private readonly allowedRoots: readonly string[];
	private readonly workspaceDirectory: string;

	constructor(options: UnprivilegedExecutionEnvOptions) {
		super({ cwd: options.cwd, shellPath: options.launcherPath });
		this.launcherPath = options.launcherPath;
		this.helperCommand = options.helperCommand;
		this.helperEnvironment = options.helperEnvironment;
		this.allowedRoots = options.allowedRoots ?? [options.cwd];
		this.workspaceDirectory = options.cwd;
	}

	private async ask(request: Omit<OwnerFileRequest, "allowedRoots">, context: Context): Promise<Result<OwnerFileResponse & { ok: true }, FileError>> {
		const path = request.path;
		const payload = JSON.stringify({ ...request, allowedRoots: this.allowedRoots });
		const signal = context.abortSignal;
		if (signal?.aborted) return err(new FileError("aborted", "aborted", path));
		return new Promise((settle) => {
			let output = "";
			let diagnostics = "";
			let settled = false;
			const finish = (result: Result<OwnerFileResponse & { ok: true }, FileError>): void => {
				if (settled) return;
				settled = true;
				settle(result);
			};
			const child = spawn(this.launcherPath, ["-c", 'exec "$@"', "chatticus-file-helper", ...this.helperCommand], {
				cwd: this.workspaceDirectory,
				env: this.helperEnvironment,
				stdio: ["pipe", "pipe", "pipe"],
				...(signal === undefined ? {} : { signal }),
			});
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				output += chunk;
			});
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => {
				diagnostics = (diagnostics + chunk).slice(-500);
			});
			child.stdin.on("error", () => undefined);
			child.on("error", (error: Error) => {
				finish(err(new FileError(signal?.aborted ? "aborted" : "unknown", signal?.aborted ? "aborted" : `The file helper could not be started: ${error.message}`, path)));
			});
			child.on("close", () => {
				let response: OwnerFileResponse;
				try {
					response = JSON.parse(output) as OwnerFileResponse;
				} catch {
					finish(err(new FileError("unknown", `The file helper gave no answer. ${diagnostics}`.trim(), path)));
					return;
				}
				if (response.ok) finish(ok(response));
				else finish(err(new FileError(CODES[response.code] ?? "unknown", response.message, path)));
			});
			child.stdin.end(payload);
		});
	}

	override async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		const answer = await this.ask({ operation: "read", path: resolve(this.cwd, path) }, context);
		if (!answer.ok) return answer;
		return ok(new Uint8Array(Buffer.from(answer.value.contentBase64 ?? "", "base64")));
	}

	override async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		const answer = await this.ask({ operation: "read", path: resolve(this.cwd, path) }, context);
		if (!answer.ok) return answer;
		return ok(Buffer.from(answer.value.contentBase64 ?? "", "base64").toString("utf8"));
	}

	override async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
		const answer = await this.ask({ operation: "write", path: resolve(this.cwd, path), contentBase64: bytes.toString("base64") }, context);
		if (!answer.ok) return answer;
		return ok(undefined);
	}

	override async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		const resolved = resolve(this.cwd, path);
		const answer = await this.ask({ operation: "stat", path: resolved }, context);
		if (!answer.ok) return answer;
		const { kind, size, mtimeMs } = answer.value;
		if (kind === undefined || kind === "other") return err(new FileError("invalid", "Unsupported file type", resolved));
		return ok({ name: basename(resolved), path: resolved, kind, size: size ?? 0, mtimeMs: mtimeMs ?? 0 });
	}

	override async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		const answer = await this.ask({ operation: "realpath", path: resolve(this.cwd, path) }, context);
		if (!answer.ok) return answer;
		return ok(answer.value.path ?? resolve(this.cwd, path));
	}

	private unsupported<T>(path: string): Promise<Result<T, FileError>> {
		return Promise.resolve(err(new FileError("not_supported", NOT_SUPPORTED_MESSAGE, path)));
	}

	override openTextLineReader(path: string): ReturnType<NodeExecutionEnv["openTextLineReader"]> {
		return this.unsupported(path);
	}

	override readTextLines(path: string): Promise<Result<string[], FileError>> {
		return this.unsupported(path);
	}

	override appendFile(path: string): Promise<Result<void, FileError>> {
		return this.unsupported(path);
	}

	override truncateFile(path: string): Promise<Result<void, FileError>> {
		return this.unsupported(path);
	}

	override flushFile(path: string): Promise<Result<void, FileError>> {
		return this.unsupported(path);
	}

	override renameFile(sourcePath: string): Promise<Result<void, FileError>> {
		return this.unsupported(sourcePath);
	}

	override listDir(path: string): Promise<Result<FileInfo[], FileError>> {
		return this.unsupported(path);
	}

	override createDir(path: string): Promise<Result<void, FileError>> {
		return this.unsupported(path);
	}

	override remove(path: string): Promise<Result<void, FileError>> {
		return this.unsupported(path);
	}
}
