import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { getTurn, listTurnEvents, type Turn, type TurnEvent, type TurnEventKind } from "../../domain/turns.ts";
import {
	cursorFromLastEventId,
	formatEventFrame,
	HEARTBEAT_FRAME,
	InvalidLastEventIdError,
	type StreamClock,
	type StreamTiming,
	writeFrameUnlessStalled,
} from "../stream.ts";
import { readableTurn, turnEventPayload, type TurnRouteDependencies } from "./turns.ts";

/** How many turn streams are open right now; the stream raises it on open and lowers it when the response ends. */
export class OpenStreamCounter {
	private openCount = 0;

	/** The number of streams currently open. */
	get open(): number {
		return this.openCount;
	}

	/** Record one stream opening. */
	opened(): void {
		this.openCount += 1;
	}

	/** Record one stream ending. */
	closed(): void {
		this.openCount -= 1;
	}
}

/** What the turn stream needs beyond the turn routes' own dependencies. */
export type TurnStreamDependencies = TurnRouteDependencies & {
	streamTiming: StreamTiming;
	streamClock: StreamClock;
	openStreams: OpenStreamCounter;
};

const TERMINAL_KINDS: ReadonlySet<string> = new Set(["turn.completed", "turn.failed", "turn.reconciling"]);

const TERMINAL_KIND_OF_STATUS: Readonly<Record<string, TurnEventKind>> = {
	completed: "turn.completed",
	failed: "turn.failed",
	reconciling: "turn.reconciling",
};

const IDLE_RECONCILING_BODY = "Stream idle; reconcile from committed state.";

/** One server-sent event frame: the kind, the integer sequence as the id, and the event as data. */
export function formatTurnEventFrame(event: TurnEvent): string {
	return formatEventFrame(event.kind, event.seq, turnEventPayload(event));
}

/**
 * The single terminal event of a finished turn whose event items have expired. The turn record keeps the status, the
 * terminal reason and the committed message sequence, so a reconnecting client still learns the outcome. The sequence
 * never rewinds below the cursor the client already holds.
 */
export function terminalEventFromTurn(turn: Turn, cursor: number, eventId: string): TurnEvent {
	const kind = TERMINAL_KIND_OF_STATUS[turn.status];
	if (kind === undefined) {
		throw new Error(`Turn ${turn.turnId} is ${turn.status}, which is not terminal.`);
	}
	const event: TurnEvent = {
		eventId,
		tenantId: turn.tenantId,
		turnId: turn.turnId,
		channelId: turn.channelId,
		seq: Math.max(cursor, turn.nextEventSeq - 1),
		kind,
	};
	if (kind === "turn.completed" && turn.messageSeq !== null) {
		event.messageSeq = turn.messageSeq;
	}
	if (kind !== "turn.completed" && turn.terminalReason !== null) {
		event.body = turn.terminalReason;
	}
	return event;
}

/**
 * GET /orgs/{tenant_id}/turns/{turn_id}/stream: the turn's durable events as server-sent events after `Last-Event-ID`,
 * oldest first, closing after the first terminal kind. The stream is a view over the stored events, so a reconnect with
 * the last seen id resumes without loss. A non-numeric `Last-Event-ID` is 400; a tenant that does not own the turn is
 * refused like the other turn reads. Quiet streams carry a heartbeat comment; a stream with no worker event for the
 * idle timeout and a turn that is not parked ends with a synthetic turn.reconciling; a stream older than the lifetime
 * cap ends without a terminal frame so the client reconnects; a turn that finished before the stored events expired is
 * answered with its one terminal event synthesized from the turn record; and a write that never settles ends the stream.
 */
export async function streamTurnHandler(c: Context, deps: TurnStreamDependencies): Promise<Response> {
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
	const clock = deps.streamClock;
	const turnWasTerminalOnOpen = TERMINAL_KIND_OF_STATUS[turn.status] !== undefined;
	return streamSSE(c, async (stream) => {
		deps.openStreams.opened();
		const stopped = new AbortController();
		stream.onAbort(() => stopped.abort());
		const writeFrame = async (frame: string): Promise<boolean> => {
			const written = await writeFrameUnlessStalled(stream, frame, timing.writeStallMilliseconds, clock);
			if (!written) stopped.abort();
			return written;
		};
		try {
			const openedAt = clock.now();
			let lastEventAt = openedAt;
			let nextHeartbeatAt = openedAt + timing.heartbeatMilliseconds;
			let pollMilliseconds = timing.minimumPollMilliseconds;
			while (!stopped.signal.aborted) {
				const now = clock.now();
				if (now - openedAt >= timing.maximumLifetimeMilliseconds) return;
				if (now - lastEventAt >= timing.idleTimeoutMilliseconds) {
					const current = await getTurn(deps.turns, turn.tenantId, turn.turnId);
					if (current.waitingFor !== null) {
						lastEventAt = now;
					} else {
						const reconciling: TurnEvent = {
							eventId: deps.turns.ids.next(),
							tenantId: turn.tenantId,
							turnId: turn.turnId,
							channelId: turn.channelId,
							seq: cursor,
							kind: "turn.reconciling",
							body: IDLE_RECONCILING_BODY,
						};
						await writeFrame(formatTurnEventFrame(reconciling));
						return;
					}
				}
				if (now >= nextHeartbeatAt) {
					if (!(await writeFrame(HEARTBEAT_FRAME))) return;
					nextHeartbeatAt = now + timing.heartbeatMilliseconds;
				}
				const events = await listTurnEvents(deps.turns, turn.tenantId, turn.turnId, cursor);
				if (events.length === 0) {
					if (turnWasTerminalOnOpen) {
						const finished = await getTurn(deps.turns, turn.tenantId, turn.turnId);
						await writeFrame(formatTurnEventFrame(terminalEventFromTurn(finished, cursor, deps.turns.ids.next())));
						return;
					}
					await clock.sleep(pollMilliseconds, stopped.signal, "poll");
					pollMilliseconds = Math.min(pollMilliseconds * 2, timing.maximumPollMilliseconds);
					continue;
				}
				pollMilliseconds = timing.minimumPollMilliseconds;
				lastEventAt = clock.now();
				for (const event of events) {
					if (!(await writeFrame(formatTurnEventFrame(event)))) return;
					cursor = event.seq;
					if (TERMINAL_KINDS.has(event.kind)) return;
				}
			}
		} finally {
			deps.openStreams.closed();
		}
	});
}
