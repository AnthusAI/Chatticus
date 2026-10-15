const MILLISECONDS_PER_DAY = 86_400_000;

/** Format a moment the way Python `datetime.isoformat()` does for UTC. */
export function pythonIsoUtc(moment: Date): string {
	const base = moment.toISOString().slice(0, 19);
	const milliseconds = moment.getUTCMilliseconds();
	if (milliseconds === 0) {
		return `${base}+00:00`;
	}
	return `${base}.${String(milliseconds * 1000).padStart(6, "0")}+00:00`;
}

/** The UTC calendar day of a moment as `YYYY-MM-DD`. */
export function utcDayOf(moment: Date): string {
	return moment.toISOString().slice(0, 10);
}

/** The calendar day written in an ISO date-time string, without zone conversion. */
export function dayWrittenIn(isoDateTime: string): string {
	return isoDateTime.slice(0, 10);
}

export function addDays(isoDay: string, days: number): string {
	const moment = new Date(`${isoDay}T00:00:00Z`);
	return utcDayOf(new Date(moment.getTime() + days * MILLISECONDS_PER_DAY));
}

export function firstDayOfMonth(isoDay: string): string {
	return `${isoDay.slice(0, 8)}01`;
}
