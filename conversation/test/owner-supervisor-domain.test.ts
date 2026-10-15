import { describe, expect, it } from "vitest";
import { liveOwnerOf } from "../src/domain/computers.ts";
import { ownerDrainReason, ownerIssuanceClosed, ownerPollCadence } from "../src/domain/owner-supervisor.ts";
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

describe("ownerDrainReason", () => {
	const renewed: Computer = { ...computer, ownerStartedAt: secondsBefore(10), ownerCredentialsExpireAt: secondsBefore(-3000) };

	it("names no reason for a computer that records neither an owner start nor a credential expiry", () => {
		const { ownerStartedAt: _removedStart, ...withoutStart } = computer;
		expect(ownerDrainReason(withoutStart, NOW, 1)).toBeNull();
		expect(ownerDrainReason({ ...withoutStart, ownerCredentialsExpireAt: secondsBefore(-10) }, NOW, 1)).toBe("credentials");
	});

	it("checks the protocol version first, then the lifetime, then the credentials", () => {
		const everything: Computer = { ...renewed, ownerStartedAt: secondsBefore(28200), ownerCredentialsExpireAt: secondsBefore(-100), ownerProtocolVersion: 1 };
		expect(ownerDrainReason(everything, NOW, 2)).toBe("protocol_version");
		expect(ownerDrainReason(everything, NOW, 1)).toBe("lifetime");
		expect(ownerDrainReason({ ...everything, ownerStartedAt: secondsBefore(100) }, NOW, 1)).toBe("credentials");
		expect(ownerDrainReason({ ...everything, ownerStartedAt: secondsBefore(100), ownerCredentialsExpireAt: secondsBefore(-601) }, NOW, 1)).toBeNull();
	});

	it("never drains an owner that did not announce a protocol version", () => {
		const { ownerProtocolVersion: _removed, ...unannounced } = renewed;
		expect(ownerDrainReason(unannounced, NOW, 3)).toBeNull();
	});
});

describe("ownerIssuanceClosed", () => {
	it("closes at 27900 seconds after the bootstrap and never for a computer that records no owner start", () => {
		expect(ownerIssuanceClosed({ ...computer, ownerStartedAt: secondsBefore(27899) }, NOW)).toBe(false);
		expect(ownerIssuanceClosed({ ...computer, ownerStartedAt: secondsBefore(27900) }, NOW)).toBe(true);
		const { ownerStartedAt: _removed, ...unowned } = computer;
		expect(ownerIssuanceClosed(unowned, NOW)).toBe(false);
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
