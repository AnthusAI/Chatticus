import { addDays, utcDayOf } from "./calendar.ts";

const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Raised when a scheduled rollup invocation names a date that is not a completed past UTC day. */
export class RollupDateInvalidError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RollupDateInvalidError";
	}
}

/** The optional input of the scheduled rollup invocation. */
export interface DailyRollupEvent {
	readonly date?: unknown;
}

/**
 * The day a scheduled rollup covers: yesterday in UTC when the invocation names no date, otherwise the named
 * `YYYY-MM-DD` day. A named day must be a real calendar day that has already ended in UTC.
 */
export function resolveRollupDate(event: DailyRollupEvent | null | undefined, now: Date): string {
	const yesterday = addDays(utcDayOf(now), -1);
	const requested = event?.date;
	if (requested === undefined || requested === null) {
		return yesterday;
	}
	if (typeof requested !== "string" || !ISO_DAY_PATTERN.test(requested)) {
		throw new RollupDateInvalidError("date must be a YYYY-MM-DD string.");
	}
	const parsed = new Date(`${requested}T00:00:00Z`);
	if (Number.isNaN(parsed.getTime()) || utcDayOf(parsed) !== requested) {
		throw new RollupDateInvalidError(`date ${requested} is not a calendar day.`);
	}
	if (requested > yesterday) {
		throw new RollupDateInvalidError(`date ${requested} has not ended yet; the latest day that can be rolled up is ${yesterday}.`);
	}
	return requested;
}
