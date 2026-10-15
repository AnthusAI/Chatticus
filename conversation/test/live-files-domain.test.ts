import { describe, expect, it } from "vitest";
import { expectedPickupMilliseconds, liveFileSourceOf, ownerFilePanelPace } from "../src/domain/live-files.ts";
import type { Computer } from "../src/store/codecs/computer.ts";
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
	ownerProtocolVersion: 2,
};

const worker = (pollState: string | undefined, lastHeartbeatSecondsAgo = 1, pace = 1000): Worker => ({
	workerId: "owner-1",
	tenantId: "anthus",
	costClass: "local",
	capabilities: ["cpu", "computer"],
	tokenHash: "hash",
	lastHeartbeatAt: secondsBefore(lastHeartbeatSecondsAgo),
	computerId: "computer-1",
	...(pollState === undefined ? {} : { pollState }),
	pollPaceMilliseconds: pace,
});

describe("liveFileSourceOf", () => {
	it("answers a computer with no owner, or an owner that stopped heartbeating, from the snapshot and not stale", () => {
		expect(liveFileSourceOf(null, null, NOW, 30)).toEqual({ source: "snapshot", reason: null, stale: false });
		const { ownerId: _none, ...off } = computer;
		expect(liveFileSourceOf(off, null, NOW, 30)).toEqual({ source: "snapshot", reason: null, stale: false });
		expect(liveFileSourceOf(computer, worker("idle", 31), NOW, 30)).toEqual({ source: "snapshot", reason: null, stale: false });
	});

	it("is live for an owner of protocol 2 that idles, serves, publishes or drains", () => {
		for (const state of ["idle", "serving", "publishing", "draining"]) {
			expect(liveFileSourceOf(computer, worker(state), NOW, 30)).toEqual({ source: "live" });
		}
	});

	it("gives the reason, stale, for an owner that cannot serve a file", () => {
		const stale = (reason: string) => ({ source: "snapshot", reason, stale: true });
		expect(liveFileSourceOf({ ...computer, ownerProtocolVersion: 1 }, worker("idle"), NOW, 30)).toEqual(stale("owner_too_old"));
		expect(liveFileSourceOf(computer, worker("booting"), NOW, 30)).toEqual(stale("owner_not_ready"));
		expect(liveFileSourceOf(computer, worker("hydrating"), NOW, 30)).toEqual(stale("owner_not_ready"));
		expect(liveFileSourceOf(computer, worker(undefined), NOW, 30)).toEqual(stale("owner_not_ready"));
		expect(liveFileSourceOf({ ...computer, hydrateRequired: true }, worker("idle"), NOW, 30)).toEqual(stale("owner_not_ready"));
		expect(liveFileSourceOf(computer, worker("stopping"), NOW, 30)).toEqual(stale("owner_stopping"));
		expect(liveFileSourceOf({ ...computer, ownerStopApprovedAt: secondsBefore(1) }, worker("idle"), NOW, 30)).toEqual(stale("owner_stopping"));
	});
});

describe("ownerFilePanelPace", () => {
	const open = new Date(NOW.getTime() + 10_000);
	it("clamps the pace to one second while the window is open, in the states that can serve a file", () => {
		expect(ownerFilePanelPace("idle", 10000, open, NOW)).toBe(1000);
		expect(ownerFilePanelPace("serving", 5000, open, NOW)).toBe(1000);
		expect(ownerFilePanelPace("idle", 500, open, NOW)).toBe(500);
	});

	it("leaves the pace alone when the window is closed, absent or the state cannot serve", () => {
		expect(ownerFilePanelPace("idle", 10000, NOW, NOW)).toBe(10000);
		expect(ownerFilePanelPace("idle", 10000, undefined, NOW)).toBe(10000);
		expect(ownerFilePanelPace("hydrating", 2000, open, NOW)).toBe(2000);
		expect(ownerFilePanelPace("stopping", 5000, open, NOW)).toBe(5000);
	});
});

describe("expectedPickupMilliseconds", () => {
	it("is the time left of the pace the owner was told, never negative", () => {
		expect(expectedPickupMilliseconds(worker("idle", 3, 10000), NOW)).toBe(7000);
		expect(expectedPickupMilliseconds(worker("idle", 12, 10000), NOW)).toBe(0);
		expect(expectedPickupMilliseconds(worker("idle", 0.2, 1000), NOW)).toBe(800);
	});
});
