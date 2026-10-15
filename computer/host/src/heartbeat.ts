import { DEFAULT_HEARTBEAT_TIMEOUT_SECONDS } from "../../../conversation/src/domain/workers.ts";
import type { HostProtocolClient } from "./protocol-client.ts";

/** What the heartbeat calls on the Front Door. */
export type HeartbeatPlane = Pick<HostProtocolClient, "heartbeat">;

/** The recurring timer the heartbeat runs on; tests drive it by hand. */
export interface HeartbeatTimer {
	start(callback: () => void, milliseconds: number): unknown;
	stop(handle: unknown): void;
}

/** The timer of a running host: the runtime's own interval. */
export const runtimeHeartbeatTimer: HeartbeatTimer = {
	start: (callback, milliseconds) => setInterval(callback, milliseconds),
	stop: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** How long the Front Door waits without a heartbeat before it ignores this host. */
export const HEARTBEAT_TIMEOUT_MILLISECONDS = DEFAULT_HEARTBEAT_TIMEOUT_SECONDS * 1000;

/** How often the host sends a heartbeat: a third of the timeout, so two in a row may fail before the host is ignored. */
export const HEARTBEAT_INTERVAL_MILLISECONDS = Math.floor(HEARTBEAT_TIMEOUT_MILLISECONDS / 3);

/** A running heartbeat. */
export interface HostHeartbeat {
	/** Stop sending heartbeats; calling it again does nothing. */
	stop(): void;
	/** Throw the failure that outlasted the timeout, if there was one; otherwise return. */
	assertAlive(): void;
}

/** What the heartbeat runs on. */
export type StartHostHeartbeatOptions = {
	readonly plane: HeartbeatPlane;
	readonly intervalMilliseconds?: number;
	readonly timeoutMilliseconds?: number;
	readonly now?: () => number;
	readonly timer?: HeartbeatTimer;
	readonly log?: (message: string) => void;
};

/** Heartbeats have failed for longer than the Front Door waits, so it has stopped routing work to this host. */
export class HeartbeatLostError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HeartbeatLostError";
	}
}

/**
 * Send a heartbeat on an interval until stopped. Registration counts as the first heartbeat. A failed heartbeat is
 * logged and the next interval tries again; once no heartbeat has succeeded for longer than the timeout the failure
 * becomes fatal and `assertAlive` throws it.
 *
 * @param options The Front Door, the interval, the timeout, the clock, the timer and the log.
 * @returns The running heartbeat.
 */
export function startHostHeartbeat(options: StartHostHeartbeatOptions): HostHeartbeat {
	const now = options.now ?? Date.now;
	const timer = options.timer ?? runtimeHeartbeatTimer;
	const log = options.log ?? ((message: string) => console.warn(message));
	const timeoutMilliseconds = options.timeoutMilliseconds ?? HEARTBEAT_TIMEOUT_MILLISECONDS;
	const intervalMilliseconds = options.intervalMilliseconds ?? Math.floor(timeoutMilliseconds / 3);
	let lastSuccessMilliseconds = now();
	let inFlight = false;
	let stopped = false;
	let fatal: HeartbeatLostError | null = null;
	const beat = async (): Promise<void> => {
		if (stopped || inFlight) {
			return;
		}
		inFlight = true;
		try {
			await options.plane.heartbeat();
			lastSuccessMilliseconds = now();
		} catch (error) {
			const silentMilliseconds = now() - lastSuccessMilliseconds;
			const detail = error instanceof Error ? error.message : String(error);
			log(`computer_host_heartbeat_failed silent_milliseconds=${silentMilliseconds} detail=${detail}`);
			if (silentMilliseconds > timeoutMilliseconds && fatal === null) {
				fatal = new HeartbeatLostError(`No heartbeat succeeded for ${silentMilliseconds} milliseconds; the last failure was: ${detail}`);
			}
		} finally {
			inFlight = false;
		}
	};
	const handle = timer.start(() => void beat(), intervalMilliseconds);
	return {
		stop(): void {
			if (stopped) {
				return;
			}
			stopped = true;
			timer.stop(handle);
		},
		assertAlive(): void {
			if (fatal !== null) {
				throw fatal;
			}
		},
	};
}
