import type {
	OwnerBootstrapRequest,
	OwnerBootstrapResponse,
	OwnerPollRequest,
	OwnerPollResponse,
	OwnerStopRequest,
	OwnerStopResponse,
} from "@chatticus/host-protocol/supervisor";
import type { HostBootPlane } from "./boot.ts";

/** The exit code of a supervisor that stopped itself in good order: idle, drained or unhealthy and approved. */
export const SUPERVISOR_EXIT_STOPPED = 0;

/** The exit code of a supervisor that fenced itself because the control plane stopped answering. */
export const SUPERVISOR_EXIT_FENCED = 4;

/** The exit code of a supervisor that learned it is no longer the owner of the computer. */
export const SUPERVISOR_EXIT_SUPERSEDED = 5;

/** The exit code of a supervisor whose bootstrap exchange failed. */
export const SUPERVISOR_EXIT_BOOTSTRAP_FAILED = 6;

/** The exit code of a supervisor whose settings were wrong. */
export const SUPERVISOR_EXIT_CONFIGURATION = 7;

/** The exit code of a supervisor that could not restore the disk. */
export const SUPERVISOR_EXIT_BOOT_FAILED = 8;

/** The exit code of a supervisor stopped by SIGTERM. */
export const SUPERVISOR_EXIT_SIGTERM = 143;

/**
 * The clock and the waits of a supervisor. Production uses the runtime clock; a scenario hands in a clock it moves by hand.
 */
export interface SupervisorClock {
	/** Milliseconds since the epoch. */
	nowMilliseconds(): number;
	/** Resolve after the given milliseconds, or at once when the signal aborts. Never rejects. */
	sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

/** The clock of a running supervisor. */
export const runtimeSupervisorClock: SupervisorClock = {
	nowMilliseconds: () => Date.now(),
	sleep: (milliseconds, signal) =>
		new Promise<void>((resolve) => {
			if (signal?.aborted === true) {
				resolve();
				return;
			}
			const handle = setTimeout(done, milliseconds);
			function done(): void {
				clearTimeout(handle);
				signal?.removeEventListener("abort", done);
				resolve();
			}
			signal?.addEventListener("abort", done, { once: true });
		}),
};

/**
 * What the supervisor asks of the Front Door: the bootstrap exchange, the poll and the stop request, and the computer
 * routes the boot driver and the disk lifecycle call. A refusal is thrown as a `HostProtocolError` carrying the status and
 * the owner error code; a network failure or a timeout is any other error.
 */
export interface SupervisorPlane extends HostBootPlane {
	bootstrap(request: OwnerBootstrapRequest): Promise<OwnerBootstrapResponse>;
	poll(request: OwnerPollRequest): Promise<OwnerPollResponse>;
	stopRequest(request: OwnerStopRequest): Promise<OwnerStopResponse>;
}

/**
 * The computer's disk as the supervisor drives it. The implementation writes the `workspace_hydrated`, `snapshot_published`,
 * `snapshot_skipped` and `snapshot_publish_failed` lines.
 */
export interface SupervisorDisk {
	/** Mark the computer running, clear the model gate, hydrate the published snapshot, share the workspace with the shell and clear the workspace gate. Throws when the disk could not be restored. */
	hydrate(): Promise<void>;
	/** Whether the live disk differs from the last published pack; false is logged as a skipped publish. */
	needsPublish(): Promise<boolean>;
	/** Pack the live disk, upload it and record it. Throws when the publish failed. */
	publish(): Promise<void>;
}

/** How a child process ended: its exit code, or the signal that ended it. */
export type ChildExit = { readonly code: number | null; readonly signal: string | null };

/** One running per-turn child. */
export interface SpawnedChild {
	readonly pid: number;
	/** Send a signal to the child and everything it started in its process group. */
	kill(signal: "SIGTERM" | "SIGKILL"): void;
	/** Settles once, when the child has ended. */
	readonly exited: Promise<ChildExit>;
}

/** The subcommands of the owner program the supervisor starts. */
export type OwnerChildSubcommand = "turn";

/** Starts the owner program with a subcommand and exactly the environment given. */
export interface ChildSpawner {
	spawn(subcommand: OwnerChildSubcommand, environment: Record<string, string>): SpawnedChild;
}

/** Kills what the model's commands left behind. */
export interface UnprivilegedProcessSweeper {
	/** Kill every process of the unprivileged shell user; resolves with how many were killed. */
	sweep(): Promise<number>;
}
