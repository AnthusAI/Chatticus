import type { SupervisorClock } from "../../../computer/host/src/supervisor-ports.ts";

type Sleeper = { readonly deadline: number; readonly wake: () => void };

const yieldToPendingWork = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * A supervisor clock that moves only when a scenario moves it. Sleepers wake in deadline order as time passes, and every
 * wake lets the supervisor run to its next wait before the clock goes on, so a step that says "900 seconds pass" runs the
 * supervisor through each of its polls and timers in order.
 */
export class FakeSupervisorClock implements SupervisorClock {
	private current: number;
	private sleepers: Sleeper[] = [];

	constructor(startMilliseconds: number = Date.parse("2026-10-12T08:00:00.000Z")) {
		this.current = startMilliseconds;
	}

	nowMilliseconds(): number {
		return this.current;
	}

	sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
		return new Promise<void>((resolve) => {
			if (signal?.aborted === true) {
				resolve();
				return;
			}
			const sleeper: Sleeper = {
				deadline: this.current + milliseconds,
				wake: () => {
					signal?.removeEventListener("abort", release);
					resolve();
				},
			};
			const release = (): void => {
				this.sleepers = this.sleepers.filter((candidate) => candidate !== sleeper);
				sleeper.wake();
			};
			this.sleepers.push(sleeper);
			signal?.addEventListener("abort", release, { once: true });
		});
	}

	/** Let everything that can run without time passing run. */
	async settle(): Promise<void> {
		await yieldToPendingWork();
		await yieldToPendingWork();
	}

	/**
	 * Move time forward, waking each sleeper at its own deadline and letting the supervisor react before the next.
	 *
	 * @param milliseconds How far to move.
	 */
	async advance(milliseconds: number): Promise<void> {
		const target = this.current + milliseconds;
		await this.settle();
		for (;;) {
			const due = this.sleepers.filter((sleeper) => sleeper.deadline <= target).sort((first, second) => first.deadline - second.deadline)[0];
			if (due === undefined) break;
			this.sleepers = this.sleepers.filter((candidate) => candidate !== due);
			this.current = Math.max(this.current, due.deadline);
			due.wake();
			await this.settle();
		}
		this.current = target;
		await this.settle();
	}
}
