import { execFile } from "node:child_process";
import { constants } from "node:os";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { WORKSPACE_DIRNAME } from "../../../../conversation/src/browser-profiles.ts";
import { safeJoin } from "../../../../conversation/src/snapshot/host.ts";
import { pythonRepr, ValueError, workspaceCwdRelative } from "../workspace-paths.ts";
import { liveRootFromEnvironment } from "./workspace.ts";

const SUPPORTED_TOOLS: ReadonlySet<string> = new Set(["run_terminal"]);
const DEFAULT_CWD = "/workspace";
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_COMMAND_LENGTH = 4096;
const CAPTURE_LIMIT_BYTES = 256 * 1024 * 1024;
const DEFAULT_SEARCH_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * Return `text` truncated to at most `maxBytes` UTF-8 bytes.
 *
 * @param text The terminal output.
 * @param maxBytes The most bytes to keep.
 */
export function truncateTerminalOutput(text: string, maxBytes: number = MAX_OUTPUT_BYTES): string {
	const encoded = Buffer.from(text, "utf8");
	if (encoded.length <= maxBytes) {
		return text;
	}
	let end = maxBytes;
	while (end > 0 && ((encoded[end] as number) & 0xc0) === 0x80) {
		end -= 1;
	}
	return `${encoded.subarray(0, end).toString("utf8")}\n...[truncated]`;
}

/**
 * Return the host directory one granted terminal cwd maps to.
 *
 * @param liveRoot The host live-disk root.
 * @param modelCwd The working directory the model named.
 * @throws ValueError If the directory escapes the workspace tree.
 */
export function resolveTerminalCwd(liveRoot: string, modelCwd: string): string {
	const relative = workspaceCwdRelative(modelCwd);
	const workspaceRoot = join(liveRoot, WORKSPACE_DIRNAME);
	if (relative === "") {
		return resolve(workspaceRoot);
	}
	return safeJoin(workspaceRoot, relative);
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

type ShellOutcome =
	| { readonly kind: "exited"; readonly returnCode: number; readonly output: string }
	| { readonly kind: "timedOut" }
	| { readonly kind: "failed"; readonly message: string };

function runShell(command: string, cwd: string): Promise<ShellOutcome> {
	const environment = {
		HOME: cwd,
		PATH: process.env["PATH"] ?? DEFAULT_SEARCH_PATH,
		LANG: process.env["LANG"] ?? "C.UTF-8",
	};
	return new Promise((settle) => {
		execFile(
			"/bin/sh",
			["-c", command],
			{ cwd, env: environment, timeout: DEFAULT_TIMEOUT_SECONDS * 1000, maxBuffer: CAPTURE_LIMIT_BYTES, encoding: "utf8" },
			(error, standardOutput, standardError) => {
				const output = `${standardOutput}${standardError}`;
				if (error === null) {
					settle({ kind: "exited", returnCode: 0, output });
					return;
				}
				if (error.killed === true && error.signal === "SIGTERM") {
					settle({ kind: "timedOut" });
					return;
				}
				if (typeof error.code === "number") {
					settle({ kind: "exited", returnCode: error.code, output });
					return;
				}
				if (typeof error.signal === "string") {
					settle({ kind: "exited", returnCode: -(constants.signals[error.signal as keyof typeof constants.signals] ?? 0), output });
					return;
				}
				settle({ kind: "failed", message: error.message });
			},
		);
	});
}

/** What the terminal executor runs on. */
export type TerminalActionExecutorOptions = {
	readonly liveRoot?: string;
};

/** Run run_terminal on the computer host using the local shell. */
export class TerminalActionExecutor {
	private readonly liveRoot: string;

	constructor(options: TerminalActionExecutorOptions = {}) {
		this.liveRoot = resolve(options.liveRoot ?? liveRootFromEnvironment());
	}

	/**
	 * Return the durable tool.result body for one terminal action.
	 *
	 * @param toolName `run_terminal`.
	 * @param arguments_ The call's arguments.
	 * @throws ValueError If the tool is not a terminal tool.
	 */
	async execute(toolName: string, arguments_: Readonly<Record<string, string>>): Promise<string> {
		if (!SUPPORTED_TOOLS.has(toolName)) {
			throw new ValueError(`TerminalActionExecutor does not support ${pythonRepr(toolName)}.`);
		}
		return this.runTerminal(arguments_);
	}

	private async runTerminal(arguments_: Readonly<Record<string, string>>): Promise<string> {
		const command = (arguments_["command"] ?? "").trim();
		if (command === "") {
			return "error: run_terminal requires command";
		}
		if (command.length > MAX_COMMAND_LENGTH) {
			return `error: command exceeds ${MAX_COMMAND_LENGTH} characters`;
		}
		const modelCwd = (arguments_["cwd"] ?? DEFAULT_CWD).trim() || DEFAULT_CWD;
		let cwd: string;
		try {
			cwd = resolveTerminalCwd(this.liveRoot, modelCwd);
		} catch (error) {
			if (error instanceof ValueError) {
				return `error: ${error.message}`;
			}
			throw error;
		}
		if (!isDirectory(cwd)) {
			return `error: cwd ${pythonRepr(modelCwd)} is not a directory on the host`;
		}
		const outcome = await runShell(command, cwd);
		if (outcome.kind === "timedOut") {
			return `error: command timed out after ${DEFAULT_TIMEOUT_SECONDS} seconds`;
		}
		if (outcome.kind === "failed") {
			return `error: ${outcome.message}`;
		}
		return `run_terminal:exit=${outcome.returnCode}\n${truncateTerminalOutput(outcome.output)}`;
	}
}
