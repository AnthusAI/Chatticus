import type { ownerOverlayAppliedRequestSchema, ownerOverlayAppliedResponseSchema, ownerOverlaySealRequestSchema, ownerOverlaySealResponseSchema } from "@chatticus/host-protocol/edit-overlay";
import type { OwnerFileResultRequest } from "@chatticus/host-protocol/live-files";
import type {
	AwsCredentials,
	OwnerBootstrapRequest,
	OwnerBootstrapResponse,
	OwnerCredentialsRequest,
	OwnerCredentialsResponse,
	OwnerPollRequest,
	OwnerPollResponse,
	OwnerStopRequest,
	OwnerStopResponse,
} from "@chatticus/host-protocol/supervisor";
import type { z } from "zod";
import type { HostBootPlane } from "./boot.ts";
import type { OverlayEntryReference } from "./overlay-applier.ts";

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
 * What the supervisor asks of the Front Door: the bootstrap exchange, the poll, the stop request and the result of a file
 * request, and the computer routes the boot driver and the disk lifecycle call. A refusal is thrown as a `HostProtocolError` carrying the status and
 * the owner error code; a network failure or a timeout is any other error.
 */
export interface SupervisorPlane extends HostBootPlane {
	bootstrap(request: OwnerBootstrapRequest): Promise<OwnerBootstrapResponse>;
	poll(request: OwnerPollRequest): Promise<OwnerPollResponse>;
	stopRequest(request: OwnerStopRequest): Promise<OwnerStopResponse>;
	/** Ask for the next set of credentials, the supervisor's own or those of the turn it serves; the response has the kind that was asked. */
	renewCredentials(request: OwnerCredentialsRequest): Promise<OwnerCredentialsResponse>;
	/** Post the owner's answer to one file request; a repeat of an answer already recorded is recorded again without harm. */
	postFileResult(request: OwnerFileResultRequest): Promise<{ readonly recorded: true }>;
	/** Close the edit overlay to member writes after the snapshot is extracted, and receive the entries to apply. */
	sealOverlay(request: z.input<typeof ownerOverlaySealRequestSchema>): Promise<z.output<typeof ownerOverlaySealResponseSchema>>;
	/** Ask the Front Door to clear applied entries once a publish that began after the apply is recorded, and report entries that were not applied. */
	postOverlayApplied(request: z.input<typeof ownerOverlayAppliedRequestSchema>): Promise<z.output<typeof ownerOverlayAppliedResponseSchema>>;
}

/** The credentials of the turn being served, as the supervisor holds them right now. */
export type TurnCredentials = {
	readonly aws_credentials: AwsCredentials;
	readonly gateway_token: string;
	readonly expires_at: string;
};

/**
 * What the socket server reads and the supervisor's turn credential lease implements: the credentials of the dispatch being
 * served, which the supervisor renews and the child only reads.
 */
export interface TurnCredentialSource {
	/**
	 * @param dispatchId The dispatch the child names.
	 * @returns The credentials held for that dispatch right now, or null when it is not the dispatch being served.
	 */
	current(dispatchId: string): TurnCredentials | null;
}

/**
 * The computer's disk as the supervisor drives it. The implementation writes the `workspace_hydrated`, `snapshot_published`,
 * `snapshot_skipped` and `snapshot_publish_failed` lines.
 */
export interface SupervisorDisk {
	/**
	 * Mark the computer running, clear the model gate, hydrate the published snapshot, share the workspace with the shell, clear the workspace
	 * gate, then seal the edit overlay and apply its entries through the file helper. Resolves with the entries now on the disk that wait for a
	 * publish and a clear. Throws when the disk could not be restored or the overlay could not be applied.
	 */
	hydrate(): Promise<readonly OverlayEntryReference[]>;
	/** Whether the live disk differs from the last published pack; false is logged as a skipped publish. */
	needsPublish(): Promise<boolean>;
	/** Pack the live disk, upload it and record it. Throws when the publish failed. */
	publish(): Promise<void>;
	/** Ask the Front Door to clear exactly these applied entries; true when it acknowledged. A refusal that ends the ownership is thrown. */
	clearApplied(entries: readonly OverlayEntryReference[]): Promise<boolean>;
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
