import { execFile } from "node:child_process";
import { accessSync, closeSync, constants, mkdirSync, openSync, readSync } from "node:fs";
import { BROWSER_ACTION_KINDS, BROWSE_ACTION_KIND } from "@chatticus/host-protocol";
import { delimiter, join } from "node:path";
import { UNTRUSTED_PARTITION, browserProfileDir, ensureBrowserProfilesLayout } from "../browser-profiles.ts";
import { pythonRepr, ValueError } from "../workspace-paths.ts";
import { liveRootFromEnvironment } from "./workspace.ts";

const SNAP_STUB_MARKERS = ["requires the chromium snap", "snap install chromium"];
const SNAP_STUB_HEAD_BYTES = 800;
const PROBE_TIMEOUT_SECONDS = 30;
const BROWSER_OPEN_TIMEOUT_SECONDS = 60;
const CAPTURE_LIMIT_BYTES = 256 * 1024 * 1024;

/** Chromium is not installed on this host. Python raised the built-in `FileNotFoundError`; the host keeps the name. */
export class FileNotFoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FileNotFoundError";
	}
}

/** Chromium ran and failed. Python raised the built-in `RuntimeError`; the host keeps the name. */
export class RuntimeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RuntimeError";
	}
}

/** A command did not finish in time. Python raised `subprocess.TimeoutExpired`; the host keeps the name. */
export class TimeoutExpired extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TimeoutExpired";
	}
}

/** How one command ended. */
export type ProcessResult = {
	readonly returnCode: number;
	readonly standardOutput: string;
	readonly standardError: string;
};

/** What a command runs with. */
export type ProcessOptions = {
	readonly environment: Readonly<Record<string, string | undefined>>;
	readonly timeoutMilliseconds: number;
};

/** The port the browser is driven through: run one command and report how it ended. Tests put a fake behind it. */
export type ProcessRunner = (command: readonly string[], options: ProcessOptions) => Promise<ProcessResult>;

/**
 * Run one command on this host and wait for it.
 *
 * @param command The program and its arguments.
 * @param options The environment and the time the command may take.
 * @throws TimeoutExpired If the command ran past its time.
 */
export const runProcessOnHost: ProcessRunner = (command, options) =>
	new Promise((settle, reject) => {
		const [program, ...arguments_] = command as [string, ...string[]];
		execFile(
			program,
			arguments_,
			{ env: { ...options.environment }, timeout: options.timeoutMilliseconds, maxBuffer: CAPTURE_LIMIT_BYTES, encoding: "utf8" },
			(error, standardOutput, standardError) => {
				if (error === null) {
					settle({ returnCode: 0, standardOutput, standardError });
					return;
				}
				if (error.killed === true && error.signal !== null && error.signal !== undefined) {
					reject(new TimeoutExpired(`Command ${pythonRepr(command.join(" "))} timed out after ${options.timeoutMilliseconds / 1000} seconds`));
					return;
				}
				const code = (error as { code?: unknown }).code;
				if (typeof code === "number") {
					settle({ returnCode: code, standardOutput, standardError });
					return;
				}
				reject(error);
			},
		);
	});

function isSnapStub(path: string): boolean {
	let head: string;
	try {
		const descriptor = openSync(path, "r");
		try {
			const buffer = Buffer.alloc(SNAP_STUB_HEAD_BYTES);
			const length = readSync(descriptor, buffer, 0, SNAP_STUB_HEAD_BYTES, 0);
			head = buffer.subarray(0, length).toString("utf8");
		} finally {
			closeSync(descriptor);
		}
	} catch {
		return false;
	}
	return SNAP_STUB_MARKERS.some((marker) => head.includes(marker));
}

function isExecutableFile(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function resolveOnPath(candidate: string): string | null {
	if (candidate.includes("/")) {
		return isExecutableFile(candidate) ? candidate : null;
	}
	for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
		if (directory === "") continue;
		const resolved = join(directory, candidate);
		if (isExecutableFile(resolved)) return resolved;
	}
	return null;
}

/**
 * Return the Chromium executable on this host.
 *
 * @throws FileNotFoundError If no candidate is installed.
 */
export function chromiumBinaryPath(): string {
	for (const candidate of [(process.env["CHATTICUS_CHROMIUM_PATH"] ?? "").trim(), "chromium-browser", "chromium", "google-chrome"]) {
		if (candidate === "") continue;
		const resolved = resolveOnPath(candidate);
		if (resolved !== null && !isSnapStub(resolved)) return resolved;
	}
	throw new FileNotFoundError("Chromium executable was not found on this host.");
}

/** What a Chromium probe runs with. */
export type VerifyChromiumOptions = {
	readonly display?: string | null;
	readonly extraArguments?: readonly string[] | null;
	readonly runner?: ProcessRunner;
	readonly binaryPath?: () => string;
};

/**
 * Probe Chromium on the configured display and return its version line.
 *
 * @param options The display, extra arguments and the process runner.
 * @throws RuntimeError If Chromium exits with an error.
 */
export async function verifyChromiumAvailable(options: VerifyChromiumOptions = {}): Promise<string> {
	const environment: Record<string, string | undefined> = { ...process.env };
	if (options.display) {
		environment["DISPLAY"] = options.display;
	}
	const command = [(options.binaryPath ?? chromiumBinaryPath)(), "--version"];
	if (options.extraArguments) {
		command.push(...options.extraArguments);
	}
	const completed = await (options.runner ?? runProcessOnHost)(command, { environment, timeoutMilliseconds: PROBE_TIMEOUT_SECONDS * 1000 });
	if (completed.returnCode !== 0) {
		const detail = (completed.standardError || completed.standardOutput || "").trim();
		throw new RuntimeError(`Chromium probe failed: ${detail || completed.returnCode}`);
	}
	return (completed.standardOutput || completed.standardError || "").trim().split(/\r\n|\r|\n/)[0] as string;
}

/** What the Chromium executor runs on. */
export type ChromiumActionExecutorOptions = {
	readonly display?: string | null;
	readonly liveRoot?: string;
	readonly runner?: ProcessRunner;
	readonly binaryPath?: () => string;
};

/** Run browse on the computer host using the local Chromium binary. */
export class ChromiumActionExecutor {
	private readonly display: string | null;
	private readonly liveRoot: string | undefined;
	private readonly runner: ProcessRunner;
	private readonly binaryPath: () => string;

	constructor(options: ChromiumActionExecutorOptions = {}) {
		this.display = options.display || (process.env["DISPLAY"] ?? "").trim() || null;
		this.liveRoot = options.liveRoot;
		this.runner = options.runner ?? runProcessOnHost;
		this.binaryPath = options.binaryPath ?? chromiumBinaryPath;
	}

	/**
	 * Return the durable tool.result body for one browser action.
	 *
	 * @param toolName `browse` or `request_computer_capability`.
	 * @param arguments_ The call's arguments.
	 * @throws ValueError If the tool is not supported, or a capability request names a gate other than the browser.
	 * @throws RuntimeError If Chromium fails to open the page.
	 */
	async execute(toolName: string, arguments_: Readonly<Record<string, string>>): Promise<string> {
		if (!BROWSER_ACTION_KINDS.has(toolName)) {
			throw new ValueError(`ChromiumActionExecutor does not support ${pythonRepr(toolName)}.`);
		}
		if (toolName === BROWSE_ACTION_KIND) {
			return this.browserOpen(arguments_);
		}
		const gate = (arguments_["gate"] ?? "browser").trim() || "browser";
		if (gate !== "browser") {
			throw new ValueError(`ChromiumActionExecutor only opens the browser for request_computer_capability gate ${pythonRepr(gate)}.`);
		}
		const url = (arguments_["url"] ?? "").trim() || "about:blank";
		return this.browserOpen({ url, storage_partition: arguments_["storage_partition"] ?? UNTRUSTED_PARTITION });
	}

	private async browserOpen(arguments_: Readonly<Record<string, string>>): Promise<string> {
		const url = (arguments_["url"] ?? "about:blank").trim() || "about:blank";
		const storagePartition = (arguments_["storage_partition"] ?? "").trim() || UNTRUSTED_PARTITION;
		const liveRoot = this.liveRoot ?? liveRootFromEnvironment();
		ensureBrowserProfilesLayout(liveRoot);
		const profileDirectory = browserProfileDir(liveRoot, storagePartition);
		mkdirSync(profileDirectory, { recursive: true });
		const environment: Record<string, string | undefined> = { ...process.env };
		if (this.display) {
			environment["DISPLAY"] = this.display;
		}
		const command = [
			this.binaryPath(),
			"--headless=new",
			"--no-sandbox",
			"--disable-gpu",
			"--disable-dev-shm-usage",
			`--user-data-dir=${profileDirectory}`,
			"--dump-dom",
			url,
		];
		const completed = await this.runner(command, { environment, timeoutMilliseconds: BROWSER_OPEN_TIMEOUT_SECONDS * 1000 });
		if (completed.returnCode !== 0) {
			const detail = (completed.standardError || completed.standardOutput || "").trim();
			throw new RuntimeError(`browse failed for ${pythonRepr(url)}: ${detail || completed.returnCode}`);
		}
		return `opened:${url}`;
	}
}
