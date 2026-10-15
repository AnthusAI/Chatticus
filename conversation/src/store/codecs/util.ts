/**
 * Codec utilities for exact Python-compatible formatting.
 */

/**
 * Format a Date as ISO string matching Python isoformat() with +00:00 timezone.
 * Strip milliseconds if they're .000 to match Python's isoformat() output.
 */
export function formatIsoDateTime(date: Date): string {
	const iso = date.toISOString();
	const withoutZ = iso.slice(0, -1);
	const noMillis = withoutZ.replace(/\.\d{3}$/, "");
	return noMillis + "+00:00";
}

/**
 * Stringify with Python-compatible spacing (space after colon and comma).
 * Python's json.dumps() produces: [1, 2] and {"key": value, ...}
 */
export function stringifyPythonStyle(value: unknown): string {
	const json = JSON.stringify(value);
	return json
		.replace(/,(?=\S)/g, ", ")
		.replace(/:(?=\S)/g, ": ");
}
