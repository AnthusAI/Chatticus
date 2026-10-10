import assert from "node:assert/strict";
import { After, Before } from "@cucumber/cucumber";
import type { ChatticusWorld } from "./world.ts";

/** One structured log line read back: the event name and its key=value fields. */
export type ParsedLogLine = { readonly event: string; readonly fields: ReadonlyMap<string, string>; readonly text: string };

type CaptureState = { readonly lines: string[]; readonly originals: Array<[(typeof METHODS)[number], (...parts: unknown[]) => void]> };

const METHODS = ["log", "info", "warn", "error", "debug"] as const;

const captures = new WeakMap<ChatticusWorld, CaptureState>();

Before({ tags: "@owner-log" }, function (this: ChatticusWorld) {
	const state: CaptureState = { lines: [], originals: [] };
	for (const method of METHODS) {
		state.originals.push([method, console[method]]);
		console[method] = (...parts: unknown[]) => {
			state.lines.push(parts.map((part) => (part instanceof Error ? `${part.message}\n${part.stack}` : String(part))).join(" "));
		};
	}
	captures.set(this, state);
});

After({ tags: "@owner-log" }, function (this: ChatticusWorld) {
	const state = captures.get(this);
	if (state === undefined) return;
	for (const [method, original] of state.originals) console[method] = original as never;
	captures.delete(this);
});

/** Every console line printed since the scenario started, for a scenario tagged `@owner-log`. */
export function capturedConsoleLines(world: ChatticusWorld): string[] {
	const state = captures.get(world);
	assert.ok(state, "The scenario does not capture the console; tag it @owner-log.");
	return state.lines;
}

const FIELD = /([A-Za-z0-9_]+)=("(?:[^"\\]|\\.)*"|\S*)/g;

/** Read one `event key=value ...` line; null when the line does not start with an identifier event name. */
export function parseLogLine(text: string): ParsedLogLine | null {
	const match = /^([a-z][a-z0-9_]*)( .*)?$/.exec(text);
	if (match === null) return null;
	const fields = new Map<string, string>();
	for (const field of (match[2] ?? "").matchAll(FIELD)) {
		const raw = field[2]!;
		fields.set(field[1]!, raw.startsWith('"') ? (JSON.parse(raw) as string) : raw);
	}
	return { event: match[1]!, fields, text };
}

/** The structured lines among the given console lines. */
export function parsedLogLines(lines: readonly string[]): ParsedLogLine[] {
	return lines.map(parseLogLine).filter((line): line is ParsedLogLine => line !== null);
}

/** Assert the events appear in the given order among the lines, not necessarily next to each other. */
export function assertEventsInOrder(lines: readonly ParsedLogLine[], expected: readonly string[]): void {
	let position = 0;
	for (const event of expected) {
		const found = lines.findIndex((line, index) => index >= position && line.event === event);
		assert.ok(found >= 0, `The log has no ${event} line after position ${position}. Events: ${lines.map((line) => line.event).join(", ")}`);
		position = found + 1;
	}
}
