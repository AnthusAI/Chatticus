import { spawn } from "node:child_process";
import { LIVE_FILE_STDOUT_MAX_BYTES } from "@chatticus/host-protocol/live-files";
import type { OwnerFileRequest as FileHelperRequest, OwnerFileResponse as FileHelperResponse } from "../../../conversation/src/pi/owner-file-helper.ts";

/** What the supervisor hands the helper, and what the helper answers; the shapes of `owner-file-helper.ts`. */
export type { FileHelperRequest, FileHelperResponse };

/** Starts the file helper once for one request. */
export interface FileHelperLauncher {
	/**
	 * Run the helper once with this request on standard input; kill it at the timeout; resolve with its parsed answer or a
	 * helper error. Never rejects.
	 */
	run(request: FileHelperRequest, timeoutMilliseconds: number): Promise<FileHelperResponse>;
}

/** What the process launcher starts and how. */
export type ProcessFileHelperLauncherOptions = {
	/** The unprivileged shell launcher, called as `<launcher> -c 'exec "$@"' chatticus-file-helper <helper command...>`. */
	readonly launcherPath: string;
	/** The program and arguments that run the helper, by absolute path. */
	readonly helperCommand: readonly string[];
	/** The directory the helper starts in: the workspace. */
	readonly workingDirectory: string;
	/** The environment the helper gets; none of the supervisor's. */
	readonly environment: Record<string, string>;
	/** The most standard output the supervisor reads from the helper; beyond it the helper is killed. */
	readonly standardOutputLimitBytes?: number;
};

const helperFailure = (code: "helper_failed" | "helper_timeout", message: string): FileHelperResponse => ({ ok: false, code, message });

/**
 * Starts the file helper through the same unprivileged launcher that starts the model's commands, writes one JSON request to
 * its standard input, reads at most a fixed number of bytes from its standard output, and kills the helper's whole process
 * group at the timeout. It does exactly what `UnprivilegedExecutionEnv` does for the Pi tools and nothing else: it never opens
 * a path itself, so a link planted in the workspace can lead the supervisor nowhere.
 */
export class ProcessFileHelperLauncher implements FileHelperLauncher {
	private readonly options: ProcessFileHelperLauncherOptions;

	constructor(options: ProcessFileHelperLauncherOptions) {
		this.options = options;
	}

	run(request: FileHelperRequest, timeoutMilliseconds: number): Promise<FileHelperResponse> {
		const limit = this.options.standardOutputLimitBytes ?? LIVE_FILE_STDOUT_MAX_BYTES;
		return new Promise<FileHelperResponse>((settle) => {
			const chunks: Buffer[] = [];
			let received = 0;
			let settled = false;
			let timedOut = false;
			let overLimit = false;
			const finish = (response: FileHelperResponse): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				settle(response);
			};
			let child: ReturnType<typeof spawn>;
			try {
				child = spawn(this.options.launcherPath, ["-c", 'exec "$@"', "chatticus-file-helper", ...this.options.helperCommand], {
					cwd: this.options.workingDirectory,
					env: this.options.environment,
					stdio: ["pipe", "pipe", "ignore"],
					detached: true,
				});
			} catch {
				settle(helperFailure("helper_failed", "The file helper could not be started."));
				return;
			}
			const killGroup = (): void => {
				try {
					if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			};
			const timer = setTimeout(() => {
				timedOut = true;
				killGroup();
				finish(helperFailure("helper_timeout", "The file helper did not answer in time and was stopped."));
			}, timeoutMilliseconds);
			child.stdout?.on("data", (chunk: Buffer) => {
				received += chunk.length;
				if (received > limit) {
					overLimit = true;
					killGroup();
					return;
				}
				chunks.push(chunk);
			});
			child.stdin?.on("error", () => undefined);
			child.on("error", () => finish(helperFailure("helper_failed", "The file helper could not be started.")));
			child.on("close", () => {
				if (timedOut) return;
				if (overLimit) {
					finish(helperFailure("helper_failed", "The file helper answered with more than it may."));
					return;
				}
				try {
					finish(JSON.parse(Buffer.concat(chunks).toString("utf8")) as FileHelperResponse);
				} catch {
					finish(helperFailure("helper_failed", "The file helper gave no usable answer."));
				}
			});
			child.stdin?.end(JSON.stringify(request));
		});
	}
}
