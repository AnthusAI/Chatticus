import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommitMeasurement } from "./dynamodb-storage.ts";

export const RESULTS_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "results");

/**
 * Summarize commit measurements: counts, transaction sizes, and latency percentiles.
 *
 * @param measurements Commit measurements of one owner or one turn.
 * @returns A JSON-friendly summary.
 */
export function summarize(measurements: readonly CommitMeasurement[]) {
	const committed = measurements.filter((each) => each.rejected === undefined);
	const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
	const percentile = (values: number[], fraction: number) =>
		values.length === 0 ? 0 : sorted(values)[Math.min(values.length - 1, Math.floor(values.length * fraction))]!;
	const milliseconds = committed.map((each) => each.milliseconds);
	const writeKinds: Record<string, number> = {};
	for (const each of committed) {
		for (const [kind, count] of Object.entries(each.writeKinds)) writeKinds[kind] = (writeKinds[kind] ?? 0) + count;
	}
	return {
		commits: committed.length,
		rejected: measurements.filter((each) => each.rejected !== undefined).map((each) => each.rejected),
		writeKinds,
		maxTransactionItems: Math.max(0, ...committed.map((each) => each.transactionItems)),
		maxTransactionBytes: Math.max(0, ...committed.map((each) => each.transactionBytes)),
		totalTransactionBytes: committed.reduce((sum, each) => sum + each.transactionBytes, 0),
		maxItemBytes: Math.max(0, ...committed.map((each) => each.largestItemBytes)),
		preReadsPerCommit: committed.length === 0 ? 0 : committed.reduce((s, e) => s + e.preReads, 0) / committed.length,
		commitMillisecondsP50: Math.round(percentile(milliseconds, 0.5) * 10) / 10,
		commitMillisecondsP95: Math.round(percentile(milliseconds, 0.95) * 10) / 10,
	};
}

/**
 * Write one result file under `results/`.
 *
 * @param name File name.
 * @param value JSON value or text.
 */
export function writeResult(name: string, value: unknown): void {
	mkdirSync(RESULTS_DIRECTORY, { recursive: true });
	writeFileSync(join(RESULTS_DIRECTORY, name), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}
