import { accessSync, constants } from "node:fs";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { consoleLogEmitter, errorNameOf, type LogEmitter } from "../../../conversation/src/observability/log-line.ts";
import { createOwnerExecutionEnv, WORKSPACE_VIRTUAL_ROOT, workspaceFileToolRunners } from "../../../conversation/src/pi/local-computer-tools.ts";
import type { LiveFileOutcome, OwnerFileRequest as LiveFileRequest } from "@chatticus/host-protocol/live-files";
import { scrubbedShellEnvironment } from "../../../conversation/src/pi/shell-environment.ts";
import { takeOverTurn, type TurnTakeoverOutcome } from "../../../conversation/src/turn/computer-owner.ts";
import type { ExecutorDeps, TurnExecutionJob } from "../../../conversation/src/turn/types.ts";
import { ProcessFileHelperLauncher } from "./live-file-helper-launcher.ts";
import { helperRequestOf, outcomeFromHelperResponse } from "./live-file-operations.ts";
import { OwnerConfigurationError } from "./owner-configuration.ts";

/** The directory of the computer's workspace as the model sees it and as the container has it. */
export const DEFAULT_WORKSPACE_ROOT = "/workspace";

/** Where the image installs the program that starts a model-chosen command as the unprivileged user. */
export const DEFAULT_SHELL_LAUNCHER_PATH = "/usr/local/bin/chatticus-shell";

/** A takeover job is wanted and cannot be run safely; nothing was written for the turn. */
export class ShellIsolationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ShellIsolationError";
	}
}

/** Where and as whom the entry point runs the turn. */
export type OwnerEntryPointOptions = {
	/** The workspace directory on this machine. */
	readonly workspaceRoot: string;
	/** The path the model sees the workspace at. */
	readonly workspacePath?: string;
	/** Identifies the owner on the turn and the actions it claims: the owner id of the supervisor that dispatched the turn. */
	readonly workerId: string;
	/**
	 * The program that starts every model-chosen command as an unprivileged user. Required: an entry point without one
	 * would run the model's commands with the owner's credentials in reach, so it refuses instead.
	 */
	readonly shellLauncherPath: string;
	/** The program and arguments, by absolute path, that run the file helper through the launcher; the image's bundled helper. */
	readonly fileHelperCommand?: readonly string[];
};

/**
 * Check that the shell launcher can be executed, so a missing or broken image fails before any turn is touched.
 *
 * @param shellLauncherPath The launcher program.
 * @throws ShellIsolationError If it does not exist or is not executable.
 */
export function assertShellLauncherUsable(shellLauncherPath: string): void {
	try {
		accessSync(shellLauncherPath, constants.X_OK);
	} catch {
		throw new ShellIsolationError(`The shell launcher ${shellLauncherPath} does not exist or cannot be executed, so no turn was taken.`);
	}
}

/**
 * Take over the dispatched turn in this process as the per-turn container owner, with the model's commands started through
 * the shell launcher. The turn is taken exactly as the executor's own core takes it; nothing here decides what a turn does.
 *
 * @param job The turn the supervisor dispatched.
 * @param deps The executor's dependencies with no-op queue pieces and the gateway models.
 * @param options Workspace, identity and the shell launcher.
 * @returns How the takeover ended.
 * @throws ShellIsolationError If the shell launcher is unusable; the turn is not claimed.
 */
export async function runOwnerEntryPoint(job: TurnExecutionJob, deps: ExecutorDeps, options: OwnerEntryPointOptions): Promise<TurnTakeoverOutcome> {
	assertShellLauncherUsable(options.shellLauncherPath);
	return takeOverTurn(job, deps, {
		workspaceRoot: options.workspaceRoot,
		workspacePath: options.workspacePath,
		workerId: options.workerId,
		shellPath: options.shellLauncherPath,
		...(options.fileHelperCommand === undefined ? {} : { fileHelperCommand: options.fileHelperCommand }),
	});
}

/** What a command run through the shell launcher left. */
export type ShellProbeResult = { readonly exitCode: number; readonly output: string };

/**
 * Run one command exactly as the owner runs a model-chosen command: through the shell launcher, with the scrubbed
 * environment, in the workspace. It exists so an image can show what the shell can and cannot reach.
 *
 * @param command The command. The text `{owner_pid}` is replaced by this process's id.
 * @param options Workspace and launcher.
 * @returns The exit code and the combined output.
 */
export async function runShellProbe(command: string, options: Pick<OwnerEntryPointOptions, "workspaceRoot" | "shellLauncherPath">): Promise<ShellProbeResult> {
	assertShellLauncherUsable(options.shellLauncherPath);
	const env = new NodeExecutionEnv({ cwd: options.workspaceRoot, shellPath: options.shellLauncherPath });
	const chunks: string[] = [];
	const result = await env.exec(
		command.replaceAll("{owner_pid}", String(process.pid)),
		{ cwd: options.workspaceRoot, env: scrubbedShellEnvironment(options.workspaceRoot), inheritEnv: false, onOutput: (text) => chunks.push(text) },
		BACKGROUND_CONTEXT,
	);
	if (!result.ok) return { exitCode: -1, output: `${chunks.join("")}${result.error.message}` };
	return { exitCode: result.value.exitCode, output: chunks.join("") };
}

/** The file tools the probe can run. */
export type FileProbeTool = "read_workspace" | "write_workspace" | "edit_workspace";

/**
 * Run one file tool exactly as the owner runs it for the model: the same runners over the same environment, so the file is
 * touched by the helper through the shell launcher and not by this process. It exists so an image can show what the file
 * tools reach when a link in the workspace leads somewhere only the owner could go.
 *
 * @param tool The tool.
 * @param args The tool's arguments (`path`; `content`; `old_text` and `new_text`).
 * @param options Workspace, launcher and the helper command.
 * @returns Whether the tool answered with an error, and the text it answered.
 */
export async function runFileProbe(
	tool: FileProbeTool,
	args: Record<string, string>,
	options: Pick<OwnerEntryPointOptions, "workspaceRoot" | "shellLauncherPath" | "fileHelperCommand">,
): Promise<{ readonly isError: boolean; readonly text: string }> {
	assertShellLauncherUsable(options.shellLauncherPath);
	const env = createOwnerExecutionEnv(options.workspaceRoot, options.shellLauncherPath, options.fileHelperCommand);
	const runner = workspaceFileToolRunners(env, options.workspaceRoot, WORKSPACE_VIRTUAL_ROOT)[tool];
	const api = { env, callId: "file-probe", output: () => undefined } as unknown as Parameters<typeof runner>[1];
	try {
		const outcome = await runner(args, api, BACKGROUND_CONTEXT);
		return { isError: outcome.isError, text: outcome.text };
	} catch (error) {
		return { isError: true, text: error instanceof Error ? error.message : String(error) };
	}
}

/** The live file operations the probe can run. */
export type LiveFileProbeKind = "list" | "read" | "write" | "stat" | "delete" | "mkdir";

/**
 * Run one live file operation exactly as the supervisor runs it for a member: the same request mapping, the same launcher
 * and the same validated answer, so the file is touched by the helper through the shell launcher and not by this process.
 * It exists so an image can show what the live operations do as the unprivileged user: a listing, a ranged read, an atomic
 * write with a precondition, and the refusal of a path inside a .git directory.
 *
 * @param kind The operation.
 * @param path The workspace path.
 * @param text For a write, the text to write; for a delete, the hash the file must have.
 * @param expectedSha256 For a write, the hash the file must have; absent, the file must not exist.
 * @param options Workspace, launcher and the helper command.
 * @returns The outcome the supervisor would post to the control plane.
 */
export async function runLiveFileProbe(
	kind: LiveFileProbeKind,
	path: string,
	text: string,
	expectedSha256: string,
	options: Pick<OwnerEntryPointOptions, "workspaceRoot" | "shellLauncherPath" | "fileHelperCommand">,
): Promise<LiveFileOutcome> {
	assertShellLauncherUsable(options.shellLauncherPath);
	const base = { operation_id: "live-file-probe", path, expires_in_ms: 8000 };
	const request: LiveFileRequest =
		kind === "list"
			? { ...base, kind, max_entries: 2000 }
			: kind === "read"
				? { ...base, kind, offset: 0, length: 262144, mask: true }
				: kind === "write"
					? { ...base, kind, content: text, precondition: expectedSha256 === "" ? { type: "if_none_match" } : { type: "if_match", sha256: expectedSha256 } }
					: kind === "delete"
						? { ...base, kind, recursive: false, precondition: { type: "if_match", sha256: text } }
						: kind === "stat"
							? { ...base, kind, tree: false }
							: { ...base, kind };
	const launcher = new ProcessFileHelperLauncher({
		launcherPath: options.shellLauncherPath,
		helperCommand: options.fileHelperCommand ?? [],
		workingDirectory: options.workspaceRoot,
		environment: scrubbedShellEnvironment(options.workspaceRoot),
	});
	return outcomeFromHelperResponse(request, await launcher.run(helperRequestOf(request, options.workspaceRoot), 6000));
}

/** Who an owner is on its log lines: the tenant, the turn and the owner id. None of them is a secret. */
export type OwnerLogScope = {
	readonly tenantId: string;
	readonly turnId: string;
	readonly ownerId: string;
};

/**
 * The emitter that writes the per-turn owner's structured log lines, each carrying the tenant, turn and owner id.
 *
 * @param scope Who the lines are about.
 * @returns The emitter.
 */
export function ownerLogEmitter(scope: OwnerLogScope): LogEmitter {
	return consoleLogEmitter({ tenant_id: scope.tenantId, turn_id: scope.turnId, owner_id: scope.ownerId });
}

/**
 * Run a per-turn owner's takeover and write its `owner_exit` line: the process exit code the outcome maps to, the outcome
 * itself and the time it took. A takeover that throws writes `outcome=error` with the error's name (never its message) and
 * the exit code {@link ownerChildExitCodeForError} maps it to, and the error goes on. The supervisor writes `owner_started` once for the whole container.
 *
 * @param log Where the line goes.
 * @param run The takeover.
 * @returns What the takeover returned.
 */
export async function observeOwnerTurn(log: LogEmitter, run: () => Promise<TurnTakeoverOutcome>): Promise<TurnTakeoverOutcome> {
	const startedAt = Date.now();
	try {
		const outcome = await run();
		log("owner_exit", { code: ownerExitCodeFor(outcome), outcome, duration_ms: Date.now() - startedAt });
		return outcome;
	} catch (error) {
		log("owner_exit", { code: ownerChildExitCodeForError(error), outcome: "error", error_name: errorNameOf(error), duration_ms: Date.now() - startedAt });
		throw error;
	}
}

/**
 * The process exit code for how a takeover ended. A turn that reached a terminal state, or was parked or yielded for
 * another owner to continue, is a clean exit; a lost turn or one left for reconciliation is not a failure either but is
 * told apart so the supervisor can see it.
 *
 * @param outcome How the takeover ended.
 * @returns 0 for a clean end, 1 otherwise.
 */
export function ownerExitCodeFor(outcome: TurnTakeoverOutcome): number {
	return outcome === "done" || outcome === "failed" || outcome === "parked" || outcome === "yielded" || outcome === "already_finished" ? 0 : 1;
}

/** The exit code of a per-turn child whose settings were wrong (and of an unknown subcommand). */
export const CHILD_EXIT_CONFIGURATION = 2;

/** The exit code of a per-turn child whose shell launcher is unusable. */
export const CHILD_EXIT_SHELL_ISOLATION = 3;

/** The exit code of a per-turn child that ended on an uncaught exception. */
export const CHILD_EXIT_UNCAUGHT = 70;

/**
 * The exit code a per-turn child ends with when its takeover threw.
 *
 * @param error What was thrown.
 * @returns 2 for a configuration error, 3 for an unusable shell launcher, 70 for anything else.
 */
export function ownerChildExitCodeForError(error: unknown): number {
	if (error instanceof OwnerConfigurationError) return CHILD_EXIT_CONFIGURATION;
	if (error instanceof ShellIsolationError) return CHILD_EXIT_SHELL_ISOLATION;
	return CHILD_EXIT_UNCAUGHT;
}
