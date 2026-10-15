/** A value a log line can carry. Absent values are left out of the line; null is written as `none`. */
export type LogFieldValue = string | number | boolean | null | undefined;

/** The named values of one log line. */
export type LogFields = Readonly<Record<string, LogFieldValue>>;

/** Writes one structured event; the fields given here follow the scope the emitter was made with. */
export type LogEmitter = (event: string, fields?: LogFields) => void;

const BARE_VALUE = /^[A-Za-z0-9_.:/@+-]+$/;

const formatValue = (value: string | number | boolean | null): string => {
	if (value === null) return "none";
	if (typeof value !== "string") return String(value);
	return BARE_VALUE.test(value) ? value : JSON.stringify(value);
};

/**
 * Format one structured event as a single line: the event name, then `key=value` pairs. A value that is not made of
 * plain identifier characters is written as a quoted JSON string, so no value can add a line or a key.
 *
 * @param event The event name, for example `turn_claimed`.
 * @param fields The values; keys with an undefined value are left out.
 * @returns The line, without a trailing newline.
 */
export function formatLogLine(event: string, fields: LogFields = {}): string {
	const parts = [event];
	for (const [key, value] of Object.entries(fields)) {
		if (value === undefined) continue;
		parts.push(`${key}=${formatValue(value)}`);
	}
	return parts.join(" ");
}

/**
 * An emitter that prints each event as one `console.info` line, with the scope fields first on every line.
 *
 * @param scope Fields that belong on every line, for example the tenant, turn and owner ids.
 * @returns The emitter.
 */
export function consoleLogEmitter(scope: LogFields = {}): LogEmitter {
	return (event, fields = {}) => {
		console.info(formatLogLine(event, { ...scope, ...fields }));
	};
}

/**
 * The name of a thrown value for a log line: the error's name, never its message, because a message can echo a value.
 *
 * @param error The thrown value.
 * @returns The error name, or `unknown`.
 */
export function errorNameOf(error: unknown): string {
	return error instanceof Error && error.name !== "" ? error.name : "unknown";
}
