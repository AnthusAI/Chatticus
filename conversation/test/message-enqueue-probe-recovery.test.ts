import { describe, expect, it } from "vitest";
import type { Turn } from "../src/domain/turns.ts";
import type { TurnProbeMessage, TurnRunJob } from "../src/domain/turn-admission.ts";
import { handleProbe, logicalEnqueueId, requestLogicalEnqueue } from "../src/turn/probes.ts";

describe("deadline probe recovery for an unpublished initial run", () => {
	it("publishes a recovery run when initial enqueue was recorded but not delivered", async () => {
		const now = new Date("2026-01-01T00:00:00.000Z");
		let turn: Turn = {
			turnId: "turn-a", tenantId: "tenant", channelId: "channel", botId: "bot", status: "active",
			promptMessageSeq: 1, promptAuthorId: "editor", attemptId: null, attempt: 0, claimedBy: null,
			leaseExpiresAt: null, deadlineAt: null, recoveryAttempts: 0, waitingFor: null, waitingSince: null,
			logicalEnqueueIds: [], pendingComputerTool: null, storageFence: null,
			nextEventSeq: 2, terminalReason: null, messageSeq: null,
		};
		const jobs: TurnRunJob[] = [];
		const probes: TurnProbeMessage[] = [];
		const runIds = new Set(turn.logicalEnqueueIds);
		const turnStore = {
			async getTurn() { return turn; },
			async listEvents() { return []; },
			async recoverExpiredTurn(request: { deadlineAt: Date }) {
				turn = { ...turn, recoveryAttempts: turn.recoveryAttempts + 1, deadlineAt: request.deadlineAt };
				return turn;
			},
			async recordLogicalEnqueue(_tenantId: string, _turnId: string, enqueueId: string) {
				if (runIds.has(enqueueId)) return false;
				runIds.add(enqueueId);
				turn = { ...turn, logicalEnqueueIds: [...runIds] };
				return true;
			},
		};
		const dependencies = {
			turns: { store: turnStore as never, clock: { now: () => now }, ids: { next: () => "event" } },
			turnRuns: { async enqueue(job: TurnRunJob) { jobs.push(job); } },
			turnProbes: { async send(message: TurnProbeMessage) { probes.push(message); } },
			submissions: { async turnAnswered() { return false; } },
			messaging: {} as never,
			computer: {} as never,
		};
		await expect(requestLogicalEnqueue(
			{ recorder: turnStore, turnRuns: { async enqueue() { throw new Error("queue delivery interrupted after durable enqueue record"); } } },
			{ tenantId: "tenant", channelId: "channel", botId: "bot", turnId: "turn-a", requiredCapabilities: ["cpu"] },
			logicalEnqueueId("turn-a"),
		)).rejects.toThrow("queue delivery interrupted");
		expect(runIds.has(logicalEnqueueId("turn-a"))).toBe(true);
		await handleProbe(dependencies, { tenantId: "tenant", turnId: "turn-a", kind: "deadline", expectAttempt: 0 });
		expect(jobs).toHaveLength(1);
		expect(jobs[0]?.turnId).toBe("turn-a");
		expect(runIds.has(logicalEnqueueId("turn-a", 1))).toBe(true);
		await handleProbe(dependencies, { tenantId: "tenant", turnId: "turn-a", kind: "deadline", expectAttempt: 0 });
		expect(jobs).toHaveLength(1);
		expect(probes.length).toBeGreaterThanOrEqual(2);
	});
});
