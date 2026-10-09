import { accessSync, constants, realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { scrubbedShellEnvironment } from "../../../conversation/src/pi/local-computer-tools.ts";
import type { SnapshotObjectStore } from "../../../conversation/src/snapshot/store.ts";
import { takeOverTurn, type TurnTakeoverOutcome } from "../../../conversation/src/turn/computer-owner.ts";
import { ComputerHostBootDriver, type HostBootPlane } from "./boot.ts";
import { publishBeforeExit } from "./disk-lifecycle.ts";
import { startHostHeartbeat, type HeartbeatPlane, type HeartbeatTimer } from "./heartbeat.ts";
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

/** What the owner asks of the Front Door around a turn: the host boot and snapshot routes and the heartbeat. */
export type OwnerSessionPlane = HostBootPlane & HeartbeatPlane;

/** Who the owner is on the Front Door and where its disk lives. */
export type OwnerSessionOptions = {
	readonly tenantId: string;
	/** The owner id; it registered as a worker under this id, and the snapshot metadata is published under it. */
	readonly workerId: string;
	readonly liveRoot?: string;
	readonly store?: SnapshotObjectStore | null;
	/** Runs after the snapshot is hydrated and before the turn, for example to share the hydrated workspace with the shell. */
	readonly afterHydrate?: () => Promise<void>;
	/** Registers what to do when the container is told to stop; the handler persists the disk and marks the computer stopped. */
	readonly onTerminate?: (handler: () => Promise<void>) => void;
	readonly heartbeatTimer?: HeartbeatTimer;
};

/**
 * Run the owner's turn between a hydrate and a publish of the computer's disk, exactly as the host worker does around its
 * loop: boot (computer running, model and workspace gates, snapshot hydrate), the turn, then publish the disk when it is
 * dirty and mark the computer stopped. The disk is persisted once, whether the turn ends, fails, or the container is told
 * to stop first. The owner heartbeats while it runs so the actions it holds are not taken for lost.
 *
 * A turn that ends `lost` (another owner holds or won the claim) persists nothing: its disk is a copy of the published
 * snapshot without the winner's work, and the computer is still running under the winner, so it neither publishes nor
 * marks the computer stopped.
 *
 * @param plane The Front Door.
 * @param options The organization, the owner id and the disk.
 * @param run The turn.
 * @returns What the turn returned.
 */
export async function runOwnerOnComputerDisk(
	plane: OwnerSessionPlane,
	options: OwnerSessionOptions,
	run: () => Promise<OwnerEntryPointOutcome>,
): Promise<OwnerEntryPointOutcome> {
	const heartbeat = startHostHeartbeat({ plane, ...(options.heartbeatTimer === undefined ? {} : { timer: options.heartbeatTimer }) });
	let closed: Promise<void> | null = null;
	let lostTurn = false;
	const close = (): Promise<void> => {
		closed ??= (async () => {
			heartbeat.stop();
			if (lostTurn) return;
			await publishBeforeExit(plane, {
				tenantId: options.tenantId,
				workerId: options.workerId,
				...(options.liveRoot === undefined ? {} : { liveRoot: options.liveRoot }),
				...(options.store === undefined ? {} : { store: options.store }),
			});
			await plane.setComputerStopped(true);
		})();
		return closed;
	};
	try {
		await new ComputerHostBootDriver(plane, {
			tenantId: options.tenantId,
			workerId: options.workerId,
			...(options.liveRoot === undefined ? {} : { liveRoot: options.liveRoot }),
			...(options.store === undefined ? {} : { store: options.store }),
		}).bootThroughWorkspace();
		options.onTerminate?.(close);
		try {
			await options.afterHydrate?.();
			const outcome = await run();
			lostTurn = outcome === "lost";
			heartbeat.assertAlive();
			return outcome;
		} finally {
			await close();
		}
	} finally {
		heartbeat.stop();
	}
}

/**
 * The process exit code for how a takeover ended. A turn that reached a terminal state, or was parked or yielded for
 * another owner to continue, is a clean exit; a lost turn or one left for reconciliation is not.
 *
 * @param outcome How the entry point ended.
 * @returns 0 for a clean end, 1 otherwise.
 */
export function ownerExitCodeFor(outcome: OwnerEntryPointOutcome): number {
	return outcome === "done" || outcome === "failed" || outcome === "parked" || outcome === "yielded" || outcome === "already_finished" ? 0 : 1;
}
