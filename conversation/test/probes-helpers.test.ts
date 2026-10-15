import { describe, expect, it } from "vitest";
import type { TurnProbeMessage } from "../src/domain/turn-admission.ts";
import type { Turn } from "../src/domain/turns.ts";
import { FaultPlan, SimulatedCrash } from "../src/turn/fault-plan.ts";
import {
	armProbe,
	finalizeEnqueueId,
	logicalEnqueueId,
	MAXIMUM_PROBE_DELAY_SECONDS,
	runJobFor,
	yieldEnqueueId,
} from "../src/turn/probes.ts";

const turn = { tenantId: "anthus", turnId: "turn-1", channelId: "channel-1", botId: "bot-1", attempt: 3 } as Turn;

describe("logical enqueue identifiers", () => {
	it("names the first delivery and each recovery attempt", () => {
		expect(logicalEnqueueId("turn-1")).toBe("turn-1#initial");
		expect(logicalEnqueueId("turn-1", 2)).toBe("turn-1#recovery-2");
	});

	it("keeps finalize and yield identifiers apart from the recovery ones", () => {
		const identifiers = new Set([
			logicalEnqueueId("turn-1"),
			logicalEnqueueId("turn-1", 1),
			finalizeEnqueueId("turn-1"),
			yieldEnqueueId("turn-1", 1),
		]);
		expect(identifiers.size).toBe(4);
	});
});

describe("armProbe", () => {
	const recorded = (): { sent: Array<{ message: TurnProbeMessage; delay: number }>; queue: { send: (m: TurnProbeMessage, d: number) => Promise<void> } } => {
		const sent: Array<{ message: TurnProbeMessage; delay: number }> = [];
		return {
			sent,
			queue: {
				async send(message, delay) {
					sent.push({ message, delay });
				},
			},
		};
	};

	it("names the attempt count the turn is on", async () => {
		const { sent, queue } = recorded();
		await armProbe(queue, turn, 60);
		expect(sent).toEqual([{ message: { tenantId: "anthus", turnId: "turn-1", kind: "deadline", expectAttempt: 3 }, delay: 60 }]);
	});

	it("keeps the delay within what an SQS delay queue accepts", async () => {
		const { sent, queue } = recorded();
		await armProbe(queue, turn, 5000);
		await armProbe(queue, turn, 0);
		await armProbe(queue, turn, 12.2);
		expect(sent.map((entry) => entry.delay)).toEqual([MAXIMUM_PROBE_DELAY_SECONDS, 1, 13]);
	});
});

describe("runJobFor", () => {
	it("asks for the turn's own bot and channel on a cpu worker", () => {
		expect(runJobFor(turn)).toEqual({
			tenantId: "anthus",
			channelId: "channel-1",
			botId: "bot-1",
			turnId: "turn-1",
			requiredCapabilities: ["cpu"],
		});
	});
});

describe("FaultPlan", () => {
	it("does nothing until armed and only at the armed boundary and window", () => {
		const plan = new FaultPlan();
		expect(() => plan.maybeCrash("worker_claim", "before")).not.toThrow();
		plan.arm("worker_claim", "after");
		expect(() => plan.maybeCrash("worker_claim", "before")).not.toThrow();
		expect(() => plan.maybeCrash("model_acceptance", "after")).not.toThrow();
		expect(() => plan.maybeCrash("worker_claim", "after")).toThrow(SimulatedCrash);
	});

	it("fires once and says where", () => {
		const plan = new FaultPlan();
		plan.arm("progress_append", "before");
		expect(() => plan.maybeCrash("progress_append", "before")).toThrow("simulated crash progress_append before");
		expect(() => plan.maybeCrash("progress_append", "before")).not.toThrow();
		expect(plan.crashedAt).toEqual({ boundary: "progress_append", window: "before" });
	});

	it("can be cleared before it fires", () => {
		const plan = new FaultPlan();
		plan.arm("acknowledgement", "before");
		plan.clear();
		expect(() => plan.maybeCrash("acknowledgement", "before")).not.toThrow();
		expect(plan.crashedAt).toBeNull();
	});
});
