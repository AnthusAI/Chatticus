import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
	cursorFromLastEventId,
	HEARTBEAT_FRAME,
	InvalidLastEventIdError,
	type StreamClock,
	wallStreamClock,
	writeFrameUnlessStalled,
} from "./stream.ts";

/** Tunables for the probe stream; defaults match the front door design. */
export interface SseProbeOptions {
	clock: StreamClock;
	heartbeatIntervalMilliseconds: number;
	eventIntervalMilliseconds: number;
	maximumStreamMilliseconds: number;
	writeStallMilliseconds: number;
	log: (line: string) => void;
}

const TERMINAL_KIND = "probe.completed";

/** Production defaults: 15 s heartbeat, 840 s lifetime, under the 900 s limit. */
export const defaultSseProbeOptions: SseProbeOptions = {
	clock: wallStreamClock,
	heartbeatIntervalMilliseconds: 15_000,
	eventIntervalMilliseconds: 1_000,
	maximumStreamMilliseconds: 840_000,
	writeStallMilliseconds: 10_000,
	log: (line) => console.log(line),
};

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
					options.clock,
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
					"poll",
				);
			}
		});
	});
	return app;
}
