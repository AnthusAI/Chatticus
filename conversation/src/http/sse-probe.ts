import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

/** Time source for the probe loop; tests inject a virtual clock. */
export interface SseProbeClock {
	now(): number;
	sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

/** Tunables for the probe stream; defaults match the front door design. */
export interface SseProbeOptions {
	clock: SseProbeClock;
	heartbeatIntervalMilliseconds: number;
	eventIntervalMilliseconds: number;
	maximumStreamMilliseconds: number;
	writeStallMilliseconds: number;
	log: (line: string) => void;
}

/** Raised for a Last-Event-ID that is not a decimal integer. */
export class InvalidLastEventIdError extends Error {}

const TERMINAL_KIND = "probe.completed";
const HEARTBEAT_FRAME = ": heartbeat\n\n";

/** Real wall clock whose sleep ends early when the signal aborts. */
export const wallClock: SseProbeClock = {
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

/** Production defaults: 15 s heartbeat, 840 s lifetime, under the 900 s limit. */
export const defaultSseProbeOptions: SseProbeOptions = {
	clock: wallClock,
	heartbeatIntervalMilliseconds: 15_000,
	eventIntervalMilliseconds: 1_000,
	maximumStreamMilliseconds: 840_000,
	writeStallMilliseconds: 10_000,
	log: (line) => console.log(line),
};

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
		throw new InvalidLastEventIdError(
			`Last-Event-ID '${headerValue}' is not a sequence.`,
		);
	}
	return Number.parseInt(stripped, 10);
}

/** Format one frame exactly as the Python control plane does: event, id, data. */
export function formatProbeFrame(
	kind: string,
	seq: number,
	payload: Record<string, unknown>,
): string {
	const data = JSON.stringify({ kind, seq, ...payload });
	return `event: ${kind}\nid: ${seq}\ndata: ${data}\n\n`;
}

/**
 * Write one frame, resolving false when the write does not settle within the
 * stall window. Under hono/aws-lambda streamHandle a client disconnect never
 * cancels the response body, so onAbort does not fire; the transform stream
 * then applies backpressure forever and the pending write is the only signal.
 */
async function writeFrameUnlessStalled(
	stream: { write(frame: string): Promise<unknown> },
	frame: string,
	stallMilliseconds: number,
): Promise<boolean> {
	let stallTimer: NodeJS.Timeout | undefined;
	const stalled = new Promise<boolean>((resolve) => {
		stallTimer = setTimeout(() => resolve(true), stallMilliseconds);
	});
	const written = stream.write(frame).then(() => false);
	const didStall = await Promise.race([written, stalled]);
	clearTimeout(stallTimer);
	return !didStall;
}

/**
 * Build the probe app. GET /sse-probe?events=N&gap_ms=M emits probe.tick frames with
 * integer seq after Last-Event-ID, then probe.completed as the terminal frame.
 * Heartbeat comments are written whenever the stream was idle for the
 * heartbeat interval. The stream ends at the maximum lifetime without a
 * terminal frame so the client reconnects with Last-Event-ID.
 */
export function createSseProbeApp(options: SseProbeOptions): Hono {
	const app = new Hono();
	app.get("/health", (context) => context.json({ ok: true }));
	app.get("/sse-probe", (context) => {
		let cursor: number;
		try {
			cursor = cursorFromLastEventId(context.req.header("Last-Event-ID"));
		} catch (error) {
			if (error instanceof InvalidLastEventIdError) {
				return context.json({ detail: error.message }, 400);
			}
			throw error;
		}
		const totalEvents = Number.parseInt(context.req.query("events") ?? "5", 10);
		const gapMilliseconds = Number.parseInt(
			context.req.query("gap_ms") ?? String(options.eventIntervalMilliseconds),
			10,
		);
		return streamSSE(context, async (stream) => {
			const abortController = new AbortController();
			stream.onAbort(() => {
				options.log("sse-probe aborted");
				abortController.abort();
			});
			const startedAt = options.clock.now();
			let lastWriteAt = startedAt;
			let nextEventAt = startedAt + gapMilliseconds;
			let seq = cursor;
			const writeFrame = async (frame: string): Promise<boolean> => {
				const written = await writeFrameUnlessStalled(
					stream,
					frame,
					options.writeStallMilliseconds,
				);
				if (!written && !abortController.signal.aborted) {
					options.log("sse-probe write stalled");
					abortController.abort();
				}
				return written;
			};
			while (!abortController.signal.aborted) {
				const now = options.clock.now();
				if (now - startedAt >= options.maximumStreamMilliseconds) {
					options.log("sse-probe lifetime reached");
					return;
				}
				if (now >= nextEventAt) {
					seq += 1;
					const terminal = seq >= totalEvents;
					const written = await writeFrame(
						formatProbeFrame(terminal ? TERMINAL_KIND : "probe.tick", seq, {
							at: now,
						}),
					);
					if (!written) {
						return;
					}
					lastWriteAt = now;
					nextEventAt = now + gapMilliseconds;
					if (terminal) {
						options.log("sse-probe completed");
						return;
					}
					continue;
				}
				if (now - lastWriteAt >= options.heartbeatIntervalMilliseconds) {
					if (!(await writeFrame(HEARTBEAT_FRAME))) {
						return;
					}
					lastWriteAt = now;
					continue;
				}
				const untilEvent = nextEventAt - now;
				const untilHeartbeat =
					options.heartbeatIntervalMilliseconds - (now - lastWriteAt);
				await options.clock.sleep(
					Math.min(untilEvent, untilHeartbeat),
					abortController.signal,
				);
			}
		});
	});
	return app;
}
