import { accessSync, constants, realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { scrubbedShellEnvironment } from "../../../conversation/src/pi/local-computer-tools.ts";
import { takeOverTurn, type TurnTakeoverOutcome } from "../../../conversation/src/turn/computer-owner.ts";
import type { ExecutorDeps, TurnExecutionJob } from "../../../conversation/src/turn/types.ts";

const execFileAsync = promisify(execFile);

/** The worker id the container owner claims turns and computer actions under. */
export const CONTAINER_OWNER_WORKER_ID = "computer-host-owner";

/** The directory of the computer's workspace as the model sees it and as the container has it. */
export const DEFAULT_WORKSPACE_ROOT = "/workspace";

/** Where the image installs the program that starts a model-chosen command as the unprivileged user. */
export const DEFAULT_SHELL_LAUNCHER_PATH = "/usr/local/bin/chatticus-shell";

/** The group that owns the workspace so the owner and the unprivileged shell can both write it. */
export const WORKSPACE_SHARING_GROUP = "chatticus-workspace";

/** A takeover job is wanted and cannot be run safely; nothing was written for the turn. */
export class ShellIsolationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ShellIsolationError";
	}
}

/** Where the entry point learns which turn to take over. */
export interface OwnerJobSource {
	/** The next takeover job addressed to this computer, or null when there is none. */
	claim(): Promise<TurnExecutionJob | null>;
}

/**
 * A job source backed by the job that started the computer: the tenant, turn and bot named in the environment by the
 * start. It yields that job once, then none. A control plane that hands out takeover jobs another way supplies another
 * source.
 *
 * @param environment The process environment.
 * @returns The source.
 */
export function startJobSourceFromEnvironment(environment: NodeJS.ProcessEnv = process.env): OwnerJobSource {
	const tenantId = (environment["CHATTICUS_TENANT_ID"] ?? "").trim();
	const turnId = (environment["CHATTICUS_TAKEOVER_TURN_ID"] ?? "").trim();
	const botId = (environment["CHATTICUS_TAKEOVER_BOT_ID"] ?? "").trim();
	let pending: TurnExecutionJob | null = tenantId !== "" && turnId !== "" && botId !== "" ? { tenantId, turnId, botId } : null;
	return {
		async claim() {
			const job = pending;
			pending = null;
			return job;
		},
	};
}

/** How the entry point ended: a takeover outcome, or `no_job` when nothing was waiting. */
export type OwnerEntryPointOutcome = TurnTakeoverOutcome | "no_job";

/** Where and as whom the entry point runs the turn. */
export type OwnerEntryPointOptions = {
	/** The workspace directory on this machine. */
	readonly workspaceRoot: string;
	/** The path the model sees the workspace at. */
	readonly workspacePath?: string;
	/** Identifies the owner on the turn and the actions it claims. */
	readonly workerId?: string;
	/**
	 * The program that starts every model-chosen command as an unprivileged user. Required: an entry point without one
	 * would run the model's commands with the owner's credentials in reach, so it refuses instead.
	 */
	readonly shellLauncherPath: string;
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
 * Claim the takeover job and run its turn in this process as the container-side owner, with the model's commands started
 * through the shell launcher. The turn is taken exactly as the executor's own core takes it; nothing here decides what a
 * turn does.
 *
 * @param source Where the job comes from.
 * @param deps The executor's dependencies with no-op queue pieces and the gateway models.
 * @param options Workspace, identity and the shell launcher.
 * @returns `no_job` when nothing was waiting, otherwise how the takeover ended.
 * @throws ShellIsolationError If the shell launcher is unusable; the job is not claimed.
 */
export async function runOwnerEntryPoint(source: OwnerJobSource, deps: ExecutorDeps, options: OwnerEntryPointOptions): Promise<OwnerEntryPointOutcome> {
	assertShellLauncherUsable(options.shellLauncherPath);
	const job = await source.claim();
	if (job === null) return "no_job";
	return takeOverTurn(job, deps, {
		workspaceRoot: options.workspaceRoot,
		workspacePath: options.workspacePath,
		workerId: options.workerId ?? CONTAINER_OWNER_WORKER_ID,
		shellPath: options.shellLauncherPath,
	});
}

/**
 * Give the workspace to the group both the owner and the unprivileged shell belong to: every file and directory is
 * group-owned and group-writable, and directories pass the group on to what is created in them.
 *
 * @param workspaceRoot The workspace directory, or a link to it.
 * @param group The group name.
 */
export async function shareWorkspaceWithShell(workspaceRoot: string, group: string = WORKSPACE_SHARING_GROUP): Promise<void> {
	const real = realpathSync(workspaceRoot);
	await execFileAsync("sh", [
		"-c",
		'chgrp -R "$1" "$2" && chmod -R g+rwX "$2" && find "$2" -type d -exec chmod g+s {} +',
		"sh",
		group,
		real,
	]);
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
