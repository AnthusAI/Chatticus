import { describe, expect, it } from "vitest";
import { liveOwnerOf } from "../src/domain/computers.ts";
import { ownerLifetimeIsOver, ownerPollCadence } from "../src/domain/owner-supervisor.ts";
import { withoutOwner, type Computer } from "../src/store/codecs/computer.ts";
import type { Worker } from "../src/store/codecs/worker.ts";

const NOW = new Date("2026-10-12T12:00:00Z");
const secondsBefore = (seconds: number): Date => new Date(NOW.getTime() - seconds * 1000);

const computer: Computer = {
	computerId: "computer-1",
	tenantId: "anthus",
	policy: "prefer_local",
	stopped: false,
	modelReady: true,
	workspaceReady: true,
	browserReady: false,
	hostStartGeneration: 3,
	hostStartDispatchedGeneration: 3,
	snapshotGeneration: 1,
	diskDirty: false,
	hydrateRequired: false,
	ownerId: "owner-1",
	ownerGeneration: 3,
	ownerProtocolVersion: 1,
	ownerStartedAt: secondsBefore(100),
	idleSinceAt: secondsBefore(50),
	ownerStopApprovedAt: secondsBefore(5),
	dispatchId: "dispatch-1",
	dispatchTurnId: "turn-1",
	dispatchActionId: "action-1",
	dispatchAttempt: 2,
	dispatchLeaseExpiresAt: secondsBefore(-25),
};

const worker = (lastHeartbeatSecondsAgo: number): Worker => ({
	workerId: "owner-1",
	tenantId: "anthus",
	costClass: "local",
	capabilities: ["cpu", "computer"],
	tokenHash: "hash",
	lastHeartbeatAt: secondsBefore(lastHeartbeatSecondsAgo),
	computerId: "computer-1",
});

describe("ownerPollCadence", () => {
	it("polls fast for the first minute of idleness, then medium until five minutes, then slow", () => {
		expect([0, 59.9, 60, 299.9, 300, 3600].map((idle) => ownerPollCadence("idle", idle))).toEqual([1000, 1000, 3000, 3000, 10000, 10000]);
	});

	it("ignores idleness for every other state", () => {
		expect(["booting", "hydrating", "publishing"].map((state) => ownerPollCadence(state as never, 9999))).toEqual([2000, 2000, 2000]);
		expect(["serving", "draining", "stopping"].map((state) => ownerPollCadence(state as never, 0))).toEqual([5000, 5000, 5000]);
	});
});

describe("ownerLifetimeIsOver", () => {
	it("drains at exactly 3000 seconds after the bootstrap and not a second before", () => {
		expect(ownerLifetimeIsOver({ ...computer, ownerStartedAt: secondsBefore(2999) }, NOW)).toBe(false);
		expect(ownerLifetimeIsOver({ ...computer, ownerStartedAt: secondsBefore(3000) }, NOW)).toBe(true);
	});

	it("never drains a computer that records no owner start", () => {
		const { ownerStartedAt: _removed, ...unowned } = computer;
		expect(ownerLifetimeIsOver(unowned, NOW)).toBe(false);
	});
});

describe("liveOwnerOf", () => {
	it("holds while the heartbeat is inside the window, to the second", () => {
		expect(liveOwnerOf(computer, worker(30), NOW, 30)).toBe(true);
		expect(liveOwnerOf(computer, worker(31), NOW, 30)).toBe(false);
	});

	it("is false for a worker that is not the owner, hosts another computer, or an owner of a finished generation", () => {
		expect(liveOwnerOf(computer, { ...worker(1), workerId: "owner-2" }, NOW, 30)).toBe(false);
		expect(liveOwnerOf(computer, { ...worker(1), computerId: "computer-2" }, NOW, 30)).toBe(false);
		expect(liveOwnerOf({ ...computer, hostStartGeneration: 4 }, worker(1), NOW, 30)).toBe(false);
		expect(liveOwnerOf(computer, null, NOW, 30)).toBe(false);
	});

	it("is false for a computer with no owner, whatever its workers do", () => {
		expect(liveOwnerOf(withoutOwner(computer), worker(1), NOW, 30)).toBe(false);
	});
});

describe("withoutOwner", () => {
	it("removes every owner and dispatch field and keeps the last owner generation", () => {
		const cleared = withoutOwner(computer);
		expect(Object.keys(cleared).filter((key) => /^(owner|dispatch|idle)/.test(key))).toEqual(["ownerGeneration"]);
		expect(cleared.ownerGeneration).toBe(3);
	});
});
