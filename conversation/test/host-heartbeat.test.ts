import { describe, expect, it } from "vitest";
import {
	HEARTBEAT_INTERVAL_MILLISECONDS,
	HEARTBEAT_TIMEOUT_MILLISECONDS,
	HeartbeatLostError,
	startHostHeartbeat,
	type HeartbeatTimer,
} from "../../computer/host/src/heartbeat.ts";
import { runHostWorker, type HostWorkerPlane } from "../../computer/host/src/main.ts";
import type { ComputerHostBootDriver } from "../../computer/host/src/boot.ts";
import { DEFAULT_HEARTBEAT_TIMEOUT_SECONDS } from "../src/domain/workers.ts";

class ManualTimer implements HeartbeatTimer {
	callback: (() => void) | null = null;
	intervalMilliseconds = 0;
	stopCount = 0;

	start(callback: () => void, milliseconds: number): unknown {
		this.callback = callback;
		this.intervalMilliseconds = milliseconds;
		return "handle";
	}

	stop(): void {
		this.stopCount += 1;
		this.callback = null;
	}

	async tick(): Promise<void> {
		this.callback?.();
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

class FakeClock {
	milliseconds = 1_000_000;
	now = (): number => this.milliseconds;
}

describe("the host heartbeat interval", () => {
	it("is one third of the Front Door's heartbeat timeout", () => {
		expect(HEARTBEAT_TIMEOUT_MILLISECONDS).toBe(DEFAULT_HEARTBEAT_TIMEOUT_SECONDS * 1000);
		expect(HEARTBEAT_INTERVAL_MILLISECONDS).toBe(10_000);
		const timer = new ManualTimer();
		startHostHeartbeat({ plane: { heartbeat: async () => undefined }, timer });
		expect(timer.intervalMilliseconds).toBe(HEARTBEAT_INTERVAL_MILLISECONDS);
	});
});

describe("startHostHeartbeat", () => {
	it("sends one heartbeat per tick", async () => {
		const timer = new ManualTimer();
		let sent = 0;
		startHostHeartbeat({ plane: { heartbeat: async () => void (sent += 1) }, timer, now: new FakeClock().now });
		await timer.tick();
		await timer.tick();
		await timer.tick();
		expect(sent).toBe(3);
	});

	it("sends no more heartbeats once stopped, and stopping twice stops the timer once", async () => {
		const timer = new ManualTimer();
		let sent = 0;
		const heartbeat = startHostHeartbeat({ plane: { heartbeat: async () => void (sent += 1) }, timer });
		await timer.tick();
		heartbeat.stop();
		heartbeat.stop();
		await timer.tick();
		expect(sent).toBe(1);
		expect(timer.stopCount).toBe(1);
	});

	it("logs a single failed heartbeat, stays alive and recovers on the next one", async () => {
		const timer = new ManualTimer();
		const clock = new FakeClock();
		const logged: string[] = [];
		let attempt = 0;
		const heartbeat = startHostHeartbeat({
			plane: {
				heartbeat: async () => {
					attempt += 1;
					if (attempt === 1) throw new Error("front door unreachable");
				},
			},
			timer,
			now: clock.now,
			log: (message) => logged.push(message),
		});
		clock.milliseconds += HEARTBEAT_INTERVAL_MILLISECONDS;
		await timer.tick();
		expect(logged).toHaveLength(1);
		expect(logged[0]).toContain("front door unreachable");
		expect(() => heartbeat.assertAlive()).not.toThrow();
		clock.milliseconds += HEARTBEAT_INTERVAL_MILLISECONDS;
		await timer.tick();
		expect(attempt).toBe(2);
		expect(() => heartbeat.assertAlive()).not.toThrow();
	});

	it("keeps failures that stay inside the timeout non-fatal", async () => {
		const timer = new ManualTimer();
		const clock = new FakeClock();
		const heartbeat = startHostHeartbeat({
			plane: { heartbeat: async () => Promise.reject(new Error("down")) },
			timer,
			now: clock.now,
			log: () => undefined,
		});
		for (let index = 0; index < 3; index += 1) {
			clock.milliseconds += HEARTBEAT_INTERVAL_MILLISECONDS;
			await timer.tick();
		}
		expect(clock.milliseconds - 1_000_000).toBe(HEARTBEAT_TIMEOUT_MILLISECONDS);
		expect(() => heartbeat.assertAlive()).not.toThrow();
	});

	it("becomes fatal when failures outlast the timeout", async () => {
		const timer = new ManualTimer();
		const clock = new FakeClock();
		const heartbeat = startHostHeartbeat({
			plane: { heartbeat: async () => Promise.reject(new Error("down")) },
			timer,
			now: clock.now,
			log: () => undefined,
		});
		for (let index = 0; index < 4; index += 1) {
			clock.milliseconds += HEARTBEAT_INTERVAL_MILLISECONDS;
			await timer.tick();
		}
		expect(() => heartbeat.assertAlive()).toThrow(HeartbeatLostError);
	});

	it("does not start a heartbeat while the previous one is still in flight", async () => {
		const timer = new ManualTimer();
		let sent = 0;
		let release: () => void = () => undefined;
		startHostHeartbeat({
			plane: {
				heartbeat: () =>
					new Promise<void>((resolve) => {
						sent += 1;
						release = resolve;
					}),
			},
			timer,
		});
		await timer.tick();
		await timer.tick();
		expect(sent).toBe(1);
		release();
		await new Promise<void>((resolve) => setImmediate(resolve));
		await timer.tick();
		expect(sent).toBe(2);
	});
});

function loopPlane(heartbeat: () => Promise<void>): HostWorkerPlane {
	return {
		heartbeat,
		claimAction: async () => null,
		postActionResult: async () => undefined,
		regateAction: async () => ({ allowed: true }),
		setComputerStopped: async () => undefined,
	} as unknown as HostWorkerPlane;
}

const bootDriver = { bootThroughBrowser: async () => ({}) } as unknown as ComputerHostBootDriver;
const executor = { execute: async () => "" };

describe("runHostWorker heartbeat", () => {
	it("sends heartbeats while it runs and stops them when it returns", async () => {
		const timer = new ManualTimer();
		const clock = new FakeClock();
		let sent = 0;
		await runHostWorker({
			plane: loopPlane(async () => void (sent += 1)),
			bootDriver,
			executor,
			tenantId: "anthus",
			deadlineMilliseconds: clock.milliseconds + 3_000,
			now: clock.now,
			sleep: async (milliseconds) => {
				await timer.tick();
				clock.milliseconds += milliseconds;
			},
			heartbeatTimer: timer,
		});
		expect(sent).toBeGreaterThanOrEqual(3);
		expect(timer.stopCount).toBe(1);
		expect(timer.callback).toBeNull();
	});

	it("stops the heartbeat when the loop fails", async () => {
		const timer = new ManualTimer();
		const failingPlane = loopPlane(async () => undefined);
		failingPlane.claimAction = async () => {
			throw new Error("claim failed");
		};
		await expect(
			runHostWorker({
				plane: failingPlane,
				bootDriver,
				executor,
				tenantId: "anthus",
				deadlineMilliseconds: Number.MAX_SAFE_INTEGER,
				heartbeatTimer: timer,
			}),
		).rejects.toThrow("claim failed");
		expect(timer.stopCount).toBe(1);
	});

	it("ends with an error, after shutting down, when the heartbeat is lost beyond the timeout", async () => {
		const timer = new ManualTimer();
		const clock = new FakeClock();
		let stopped = false;
		const plane = loopPlane(async () => Promise.reject(new Error("down")));
		plane.setComputerStopped = async () => {
			stopped = true;
			return undefined as never;
		};
		await expect(
			runHostWorker({
				plane,
				bootDriver,
				executor,
				tenantId: "anthus",
				deadlineMilliseconds: Number.MAX_SAFE_INTEGER,
				now: clock.now,
				sleep: async () => {
					clock.milliseconds += HEARTBEAT_INTERVAL_MILLISECONDS;
					await timer.tick();
				},
				heartbeatTimer: timer,
				heartbeatLog: () => undefined,
			}),
		).rejects.toThrow(HeartbeatLostError);
		expect(stopped).toBe(true);
		expect(timer.stopCount).toBe(1);
	});
});
