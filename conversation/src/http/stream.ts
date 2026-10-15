/** Why a stream is waiting: to poll the stored events again, or to decide that a pending write has stalled. */
export type StreamWait = "poll" | "write-stall";

/** Time source for turn streams; tests inject a controllable clock so no scenario depends on real waiting. */
export interface StreamClock {
	/** Monotonic milliseconds. */
	now(): number;
	/** Wait the given milliseconds, ending early when the signal aborts. */
	sleep(milliseconds: number, signal: AbortSignal, purpose: StreamWait): Promise<void>;
}

/** Tunables for one turn stream: poll backoff, heartbeat, idle give-up, lifetime and the stalled-write window. */
export type StreamTiming = {
	readonly minimumPollMilliseconds: number;
	readonly maximumPollMilliseconds: number;
	readonly heartbeatMilliseconds: number;
	readonly idleTimeoutMilliseconds: number;
	readonly maximumLifetimeMilliseconds: number;
	readonly writeStallMilliseconds: number;
};

/**
 * The design's pacing: poll from 50 ms backing off to 1 s, a heartbeat comment every 15 s, a synthetic
 * turn.reconciling after 600 s without a worker event, and a close at 840 s so the stream ends before the 900 s
 * Lambda limit and the client reconnects with Last-Event-ID.
 */
export const DEFAULT_STREAM_TIMING: StreamTiming = {
	minimumPollMilliseconds: 50,
	maximumPollMilliseconds: 1000,
	heartbeatMilliseconds: 15_000,
	idleTimeoutMilliseconds: 600_000,
	maximumLifetimeMilliseconds: 840_000,
	writeStallMilliseconds: 10_000,
};

/** The comment frame that puts bytes on the wire without being an event. */
export const HEARTBEAT_FRAME = ": heartbeat\n\n";

/** Real wall clock whose sleep ends early when the signal aborts. */
export const wallStreamClock: StreamClock = {
	now: () => Date.now(),
	sleep: (milliseconds, signal) =>
		new Promise((resolve) => {
			if (signal.aborted) {
				resolve();
				return;
			}
			const timer = setTimeout(done, milliseconds);
			function done(): void {
				clearTimeout(timer);
				signal.removeEventListener("abort", done);
				resolve();
			}
			signal.addEventListener("abort", done, { once: true });
		}),
};

/** Raised for a Last-Event-ID that is not a decimal integer. */
export class InvalidLastEventIdError extends Error {}

/**
 * Parse a Last-Event-ID header into an exclusive seq cursor.
 * Missing or blank means 0; anything but decimal digits throws.
 */
export function cursorFromLastEventId(headerValue: string | undefined): number {
	if (headerValue === undefined) {
		return 0;
	}
	const stripped = headerValue.trim();
	if (stripped === "") {
		return 0;
	}
	if (!/^[0-9]+$/.test(stripped)) {
		throw new InvalidLastEventIdError(`Last-Event-ID '${headerValue}' is not a sequence.`);
	}
	return Number.parseInt(stripped, 10);
}

/**
 * Format one frame in the order the Python control plane writes it: event, id, data. Hono's writeSSE emits data before
 * id, so frames are written raw.
 */
export function formatEventFrame(kind: string, seq: number, payload: Record<string, unknown>): string {
	return `event: ${kind}\nid: ${seq}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Write one frame, resolving false when the write does not settle within the stall window. A client disconnect does
 * not always cancel the response body (under the Lambda streaming adapter it never does), so a write that stays
 * pending is the only signal that nobody is reading.
 */
export async function writeFrameUnlessStalled(
	stream: { write(frame: string): Promise<unknown> },
	frame: string,
	stallMilliseconds: number,
	clock: StreamClock,
): Promise<boolean> {
	const stallGuard = new AbortController();
	const stalled = clock.sleep(stallMilliseconds, stallGuard.signal, "write-stall").then(() => !stallGuard.signal.aborted);
	const written = stream.write(frame).then(() => false);
	const didStall = await Promise.race([written, stalled]);
	stallGuard.abort();
	return !didStall;
}
