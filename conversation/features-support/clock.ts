/**
 * Interface for a clock that provides the current time.
 */
export interface Clock {
	now(): Date;
}

/**
 * A controllable fake clock for testing. Starts at a fixed time and can be
 * advanced by calling advanceSeconds.
 */
export class FakeClock implements Clock {
	private currentTime: Date;

	constructor(startTime?: Date) {
		this.currentTime = startTime ?? new Date("2026-08-31T06:00:00Z");
	}

	now(): Date {
		return new Date(this.currentTime);
	}

	advanceSeconds(n: number): void {
		this.currentTime = new Date(this.currentTime.getTime() + n * 1000);
	}
}

/**
 * Interface for a source of unique identifiers.
 */
export interface IdSource {
	next(): string;
}

/**
 * A sequential ID source that generates IDs by incrementing a counter.
 * Each ID is formatted as a 10-digit zero-padded string.
 */
export class SequentialIdSource implements IdSource {
	private counter = 0;

	next(): string {
		return String(++this.counter).padStart(10, "0");
	}
}
