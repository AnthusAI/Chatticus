import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { listTurnEvents, type TurnEvent } from "../../domain/turns.ts";
import { cursorFromLastEventId, InvalidLastEventIdError } from "../sse-probe.ts";
import { readableTurn, turnEventPayload, type TurnRouteDependencies } from "./turns.ts";

/** How the turn stream paces its reads of the durable events. */
export type TurnStreamTiming = {
	readonly minimumPollMilliseconds: number;
	readonly maximumPollMilliseconds: number;
	readonly heartbeatMilliseconds: number;
};

/** The design's pacing: poll from 50 ms backing off to 1 s, a heartbeat comment every 15 s. */
export const DEFAULT_TURN_STREAM_TIMING: TurnStreamTiming = {
	minimumPollMilliseconds: 50,
	maximumPollMilliseconds: 1000,
	heartbeatMilliseconds: 15_000,
};

const TERMINAL_KINDS: ReadonlySet<string> = new Set(["turn.completed", "turn.failed", "turn.reconciling"]);

/** One server-sent event frame: the kind, the integer sequence as the id, and the event as data. */
export function formatTurnEventFrame(event: TurnEvent): string {
	return `event: ${event.kind}\nid: ${event.seq}\ndata: ${JSON.stringify(turnEventPayload(event))}\n\n`;
}

/**
 * GET /orgs/{tenant_id}/turns/{turn_id}/stream: the turn's durable events as server-sent events after `Last-Event-ID`,
 * oldest first, closing after the first terminal kind. The stream is a view over the stored events, so a reconnect with
 * the last seen id resumes without loss. A non-numeric `Last-Event-ID` is 400; a tenant that does not own the turn is
 * refused like the other turn reads.
 */
export async function streamTurnHandler(
	c: Context,
	deps: TurnRouteDependencies & { streamTiming: TurnStreamTiming },
): Promise<Response> {
	const turn = await readableTurn(c, deps);
	if (turn instanceof Response) return turn;
	let cursor: number;
	try {
		cursor = cursorFromLastEventId(c.req.header("Last-Event-ID"));
	} catch (error) {
		if (error instanceof InvalidLastEventIdError) return c.json({ detail: error.message }, 400);
		throw error;
	}
	const timing = deps.streamTiming;
	return streamSSE(c, async (stream) => {
		let aborted = false;
		stream.onAbort(() => {
			aborted = true;
		});
		let pollMilliseconds = timing.minimumPollMilliseconds;
		let nextHeartbeatAt = Date.now() + timing.heartbeatMilliseconds;
		while (!aborted) {
			const events = await listTurnEvents(deps.turns, turn.tenantId, turn.turnId, cursor);
			if (events.length === 0) {
				if (Date.now() >= nextHeartbeatAt) {
					await stream.write(": heartbeat\n\n");
					nextHeartbeatAt = Date.now() + timing.heartbeatMilliseconds;
				}
				await stream.sleep(pollMilliseconds);
				pollMilliseconds = Math.min(pollMilliseconds * 2, timing.maximumPollMilliseconds);
				continue;
			}
			pollMilliseconds = timing.minimumPollMilliseconds;
			for (const event of events) {
				await stream.write(formatTurnEventFrame(event));
				cursor = event.seq;
				if (TERMINAL_KINDS.has(event.kind)) return;
			}
		}
	});
}
