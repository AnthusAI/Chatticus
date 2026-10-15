import { describe, expect, it } from "vitest";
import { createSseProbeApp, type SseProbeOptions } from "../src/http/sse-probe.ts";
import { cursorFromLastEventId, InvalidLastEventIdError, type StreamClock, type StreamWait } from "../src/http/stream.ts";

class VirtualClock implements StreamClock {
	currentMilliseconds = 0;
	now(): number {
		return this.currentMilliseconds;
	}
	async sleep(milliseconds: number, signal: AbortSignal, purpose: StreamWait): Promise<void> {
		if (signal.aborted) {
			return;
		}
		if (purpose === "write-stall") {
			await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
			return;
		}
		this.currentMilliseconds += milliseconds;
		await new Promise((resolve) => setImmediate(resolve));
	}
}

function probeOptions(
	clock: VirtualClock,
	logged: string[],
	overrides: Partial<SseProbeOptions> = {},
): SseProbeOptions {
	return {
		clock,
		heartbeatIntervalMilliseconds: 15_000,
		eventIntervalMilliseconds: 1_000,
		maximumStreamMilliseconds: 840_000,
		writeStallMilliseconds: 10_000,
		log: (line) => logged.push(line),
		...overrides,
	};
}

describe("cursorFromLastEventId", () => {
	it("treats a missing or blank header as nothing seen", () => {
		expect(cursorFromLastEventId(undefined)).toBe(0);
		expect(cursorFromLastEventId("  ")).toBe(0);
	});
	it("parses a decimal integer", () => {
		expect(cursorFromLastEventId(" 17 ")).toBe(17);
	});
	it("rejects anything else", () => {
		expect(() => cursorFromLastEventId("abc")).toThrow(InvalidLastEventIdError);
		expect(() => cursorFromLastEventId("-1")).toThrow(InvalidLastEventIdError);
		expect(() => cursorFromLastEventId("1.5")).toThrow(InvalidLastEventIdError);
	});
});

describe("GET /sse-probe", () => {
	it("streams integer-seq frames and ends on the terminal kind", async () => {
		const logged: string[] = [];
		const app = createSseProbeApp(probeOptions(new VirtualClock(), logged));
		const response = await app.request("/sse-probe?events=3");
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const text = await response.text();
		const frames = text.split("\n\n").filter((frame) => frame !== "");
		expect(frames).toHaveLength(3);
		frames.forEach((frame, index) => {
			const seq = index + 1;
			const kind = seq === 3 ? "probe.completed" : "probe.tick";
			const lines = frame.split("\n");
			expect(lines[0]).toBe(`event: ${kind}`);
			expect(lines[1]).toBe(`id: ${seq}`);
			expect(lines[2].startsWith("data: ")).toBe(true);
			const payload = JSON.parse(lines[2].slice("data: ".length));
			expect(payload.kind).toBe(kind);
			expect(Number.isInteger(payload.seq)).toBe(true);
			expect(payload.seq).toBe(seq);
		});
		expect(logged).toContain("sse-probe completed");
	});

	it("resumes after Last-Event-ID", async () => {
		const app = createSseProbeApp(probeOptions(new VirtualClock(), []));
		const response = await app.request("/sse-probe?events=5", {
			headers: { "Last-Event-ID": "3" },
		});
		const text = await response.text();
		expect(text).toContain("id: 4\n");
		expect(text).toContain("id: 5\n");
		expect(text).not.toContain("id: 3\n");
		expect(text).toContain("event: probe.completed\nid: 5\n");
	});

	it("rejects a non-numeric Last-Event-ID with 400", async () => {
		const app = createSseProbeApp(probeOptions(new VirtualClock(), []));
		const response = await app.request("/sse-probe", {
			headers: { "Last-Event-ID": "abc" },
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			detail: "Last-Event-ID 'abc' is not a sequence.",
		});
	});

	it("writes a heartbeat comment every 15 seconds while idle", async () => {
		const clock = new VirtualClock();
		const app = createSseProbeApp(
			probeOptions(clock, [], {
				eventIntervalMilliseconds: 40_000,
			}),
		);
		const response = await app.request("/sse-probe?events=1");
		const text = await response.text();
		expect(text.match(/^: heartbeat$/gm)).toHaveLength(2);
		expect(text).toContain("event: probe.completed\nid: 1\n");
		expect(clock.currentMilliseconds).toBe(40_000);
	});

	it("ends at the maximum lifetime without a terminal frame", async () => {
		const logged: string[] = [];
		const clock = new VirtualClock();
		const app = createSseProbeApp(
			probeOptions(clock, logged, {
				eventIntervalMilliseconds: 10_000_000,
				maximumStreamMilliseconds: 60_000,
			}),
		);
		const response = await app.request("/sse-probe?events=1");
		const text = await response.text();
		expect(text.match(/^: heartbeat$/gm)).toHaveLength(3);
		expect(text).not.toContain("event:");
		expect(logged).toContain("sse-probe lifetime reached");
	});

	it("stops the loop when the client cancels the body", async () => {
		const logged: string[] = [];
		const app = createSseProbeApp(
			probeOptions(new VirtualClock(), logged, {
				clock: {
					now: () => Date.now(),
					sleep: (milliseconds, signal) =>
						new Promise((resolve) => {
							const timer = setTimeout(resolve, milliseconds);
							signal.addEventListener("abort", () => {
								clearTimeout(timer);
								resolve();
							});
						}),
				},
				eventIntervalMilliseconds: 20,
			}),
		);
		const response = await app.request("/sse-probe?events=1000");
		const reader = response.body!.getReader();
		await reader.read();
		await reader.cancel();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(logged).toContain("sse-probe aborted");
		expect(logged).not.toContain("sse-probe completed");
	});
});
