import type { SupervisorClock } from "../../../computer/host/src/supervisor-ports.ts";
import type { FakeClock } from "../clock.ts";

type Sleeper = { readonly deadline: number; readonly wake: () => void };

/**
 * The supervisor's clock over the clock of the scenario's control plane, so one moment is the moment of both. It moves only
 * when a scenario wakes the next sleeper, which sets the shared clock to that sleeper's deadline.
 */
export class WorldSupervisorClock implements SupervisorClock {
	private readonly world: FakeClock;
	private sleepers: Sleeper[] = [];

	constructor(world: FakeClock) {
		this.world = world;
	}

	nowMilliseconds(): number {
		return this.world.now().getTime();
	}

	sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
		return new Promise<void>((resolve) => {
			if (signal?.aborted === true) {
				resolve();
				return;
			}
			const sleeper: Sleeper = {
				deadline: this.nowMilliseconds() + milliseconds,
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

	/** Whether any sleeper waits for time to pass. */
	hasSleepers(): boolean {
		return this.sleepers.length > 0;
	}

	/** The earliest deadline of any sleeper, or undefined when none sleeps. */
	nextDeadlineMilliseconds(): number | undefined {
		return this.sleepers.length === 0 ? undefined : Math.min(...this.sleepers.map((sleeper) => sleeper.deadline));
	}

	/** Move the shared clock to the earliest deadline, if it is in the future, and wake that sleeper. */
	wakeNext(): void {
		const next = [...this.sleepers].sort((first, second) => first.deadline - second.deadline)[0];
		if (next === undefined) return;
		this.sleepers = this.sleepers.filter((candidate) => candidate !== next);
		const behindMilliseconds = next.deadline - this.nowMilliseconds();
		if (behindMilliseconds > 0) this.world.advanceSeconds(behindMilliseconds / 1000);
		next.wake();
	}
}
