import { type StreamClock, type StreamWait, wallStreamClock } from "../src/http/stream.ts";

type Sleeper = { wakeAt: number; purpose: StreamWait; resolve: () => void };

/**
 * A stream clock that only moves when a step moves it. A stream sleeping on it wakes when `advance` carries the time
 * past its wake-up, never because real time passed, so a scenario's outcome does not depend on how fast the runner is.
 */
export class ControlledStreamClock implements StreamClock {
	private currentMilliseconds = 0;
	private readonly sleepers = new Set<Sleeper>();
	private readonly pollListeners: Array<() => void> = [];

	now(): number {
		return this.currentMilliseconds;
	}

	sleep(milliseconds: number, signal: AbortSignal, purpose: StreamWait): Promise<void> {
		return new Promise((resolve) => {
			if (signal.aborted) {
				resolve();
				return;
			}
			const sleepers = this.sleepers;
			const sleeper: Sleeper = {
				wakeAt: this.currentMilliseconds + milliseconds,
				purpose,
				resolve: () => {
					signal.removeEventListener("abort", onAbort);
					resolve();
				},
			};
			function onAbort(): void {
				sleepers.delete(sleeper);
				sleeper.resolve();
			}
			sleepers.add(sleeper);
			signal.addEventListener("abort", onAbort, { once: true });
			if (purpose === "poll") {
				for (const listener of this.pollListeners.splice(0)) listener();
			}
		});
	}

	private hasPollingStream(): boolean {
		return [...this.sleepers].some((sleeper) => sleeper.purpose === "poll");
	}

	/** Resolve once a stream is waiting to poll, immediately when one already is. */
	untilPolling(): Promise<void> {
		if (this.hasPollingStream()) return Promise.resolve();
		return new Promise<void>((resolve) => this.pollListeners.push(resolve));
	}

	/**
	 * Move time forward once a stream is waiting to poll, then wake everything whose wake-up has passed. Waiting for the
	 * stream first means the step never moves time while the stream is in the middle of a read or a write.
	 */
	async advance(milliseconds: number): Promise<void> {
		if (!this.hasPollingStream()) {
			await new Promise<void>((resolve) => this.pollListeners.push(resolve));
		}
		this.currentMilliseconds += milliseconds;
		for (const sleeper of [...this.sleepers]) {
			if (sleeper.wakeAt <= this.currentMilliseconds) {
				this.sleepers.delete(sleeper);
				sleeper.resolve();
			}
		}
	}
}

/**
 * The clock the scenario's turn streams read. It is the wall clock until a step takes control, so ordinary scenarios
 * stream at the fast poll timing, and a controlled clock afterwards for the scenarios about time itself.
 */
export class ScenarioStreamClock implements StreamClock {
	private controlled: ControlledStreamClock | null = null;

	/** Take control of time for streams opened from now on. */
	takeControl(): ControlledStreamClock {
		if (this.controlled === null) {
			this.controlled = new ControlledStreamClock();
		}
		return this.controlled;
	}

	/** The controlled clock, or null while streams run on the wall clock. */
	get controlledClock(): ControlledStreamClock | null {
		return this.controlled;
	}

	now(): number {
		return (this.controlled ?? wallStreamClock).now();
	}

	sleep(milliseconds: number, signal: AbortSignal, purpose: StreamWait): Promise<void> {
		return (this.controlled ?? wallStreamClock).sleep(milliseconds, signal, purpose);
	}
}
