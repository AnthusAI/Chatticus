import { describe, expect, it } from "vitest";
import { terminalEventFromTurn } from "../src/http/routes/turn-stream.ts";
import type { Turn } from "../src/domain/turns.ts";
import { ControlledStreamClock } from "../features-support/stream-clock.ts";
import { formatEventFrame, writeFrameUnlessStalled } from "../src/http/stream.ts";

function turnRecord(overrides: Partial<Turn>): Turn {
	return {
		turnId: "turn-1",
		tenantId: "anthus",
		channelId: "channel-1",
		botId: "bot-1",
		status: "completed",
		promptMessageSeq: 1,
		promptAuthorId: "ryan",
		attemptId: "attempt-1",
		attempt: 1,
		claimedBy: null,
		leaseExpiresAt: null,
		deadlineAt: null,
		recoveryAttempts: 0,
		waitingFor: null,
		waitingSince: null,
		logicalEnqueueIds: [],
		pendingComputerTool: null,
		storageFence: null,
		nextEventSeq: 9,
		terminalReason: null,
		messageSeq: 7,
		ledgerInputRecorded: 0,
		ledgerOutputRecorded: 0,
		...overrides,
	};
}

describe("formatEventFrame", () => {
	it("writes the event name, then the id, then the data", () => {
		expect(formatEventFrame("turn.token", 3, { kind: "turn.token", seq: 3 })).toBe(
			'event: turn.token\nid: 3\ndata: {"kind":"turn.token","seq":3}\n\n',
		);
	});
});

describe("terminalEventFromTurn", () => {
	it("names the committed message of a completed turn and never rewinds the cursor", () => {
		const event = terminalEventFromTurn(turnRecord({}), 2, "event-1");
		expect(event).toMatchObject({ kind: "turn.completed", seq: 8, messageSeq: 7 });
		expect(terminalEventFromTurn(turnRecord({}), 20, "event-2").seq).toBe(20);
	});

	it("carries the reason of a failed turn", () => {
		const event = terminalEventFromTurn(turnRecord({ status: "failed", terminalReason: "model unavailable" }), 0, "event-1");
		expect(event).toMatchObject({ kind: "turn.failed", body: "model unavailable" });
	});

	it("refuses a turn that is still active", () => {
		expect(() => terminalEventFromTurn(turnRecord({ status: "active" }), 0, "event-1")).toThrow(/not terminal/);
	});
});

describe("writeFrameUnlessStalled", () => {
	it("reports a write that settles before the stall window as written", async () => {
		const clock = new ControlledStreamClock();
		const written = await writeFrameUnlessStalled({ write: async () => undefined }, "frame", 10_000, clock);
		expect(written).toBe(true);
	});

	it("reports a write that never settles as stalled once stream time passes the window", async () => {
		const clock = new ControlledStreamClock();
		const pending = writeFrameUnlessStalled({ write: () => new Promise(() => undefined) }, "frame", 10_000, clock);
		const poller = new AbortController();
		const polling = clock.sleep(1, poller.signal, "poll");
		await clock.advance(10_000);
		await polling;
		expect(await pending).toBe(false);
	});

	it("does not report a stall while stream time has not reached the window", async () => {
		const clock = new ControlledStreamClock();
		let settle: () => void = () => undefined;
		const slow = new Promise<void>((resolve) => {
			settle = resolve;
		});
		const pending = writeFrameUnlessStalled({ write: () => slow }, "frame", 10_000, clock);
		const poller = new AbortController();
		const polling = clock.sleep(1, poller.signal, "poll");
		await clock.advance(9_999);
		await polling;
		settle();
		expect(await pending).toBe(true);
	});
});
