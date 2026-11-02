import type { Context } from "@earendil-works/chord";
import type { Harness } from "@earendil-works/pi-durable";
import { summarizeProviderFailure } from "./classify-errors.ts";
import type { LogFields } from "../observability/log-line.ts";

const NOISY_EVENT_TYPES = new Set(["message_update", "tool_execution_update"]);

const readable = (value: unknown): string => summarizeProviderFailure(typeof value === "string" ? value : JSON.stringify(value ?? "")).message;

const settledText = (record: { id: unknown; status: string; reason?: unknown; detail?: unknown }): string =>
	`${String(record.id)}:${record.status}${record.reason === undefined ? "" : `:${String(record.reason)}`}${record.detail === undefined ? "" : `:${readable(record.detail)}`}`;

/**
 * Summarise one batch of Pi events for a log line: the event types in order with streamed deltas counted, and what a
 * failure, a retry or a settled submission said, with anything shaped like a key removed. A batch of streamed deltas
 * alone returns null, so a long answer does not flood the log.
 *
 * @param events The batch.
 * @returns The fields of a `pi_events` line, or null when the batch is only deltas.
 */
export function describePiEvents(events: readonly { readonly type: string }[]): LogFields | null {
	const kept = events.filter((event) => !NOISY_EVENT_TYPES.has(event.type));
	if (kept.length === 0) return null;
	const details: string[] = [];
	for (const event of kept as ReadonlyArray<Record<string, any>>) {
		if (event.type === "task_failed") details.push(`task_failed:${String(event.kind)}:${readable(event.message)}`);
		else if (event.type === "auto_retry_start") details.push(`auto_retry_start:attempt=${String(event.attempt)}:at=${String(event.at)}:${readable(event.errorMessage)}`);
		else if (event.type === "submission") details.push(`submission:${settledText(event.record)}`);
	}
	return { events: kept.map((event) => event.type).join(","), deltas: events.length - kept.length, details: details.join(" | ") };
}

/**
 * What the Pi harness holds live: whether scheduling runs, every unfinished task with its scheduling state (and why it is
 * blocked), and every unsettled submission. Read only; it runs no task code.
 *
 * @param harness The owner's harness.
 * @param context The turn context.
 * @returns The fields of a `pi_state` line.
 */
export async function describePiState(harness: Harness, context: Context): Promise<LogFields> {
	const inspection = await harness.inspect(context);
	return {
		scheduling: inspection.scheduling,
		tasks: inspection.tasks
			.map((task) => `${task.record.kind}:${task.record.state.status}:${task.state.kind}${task.state.kind === "blocked" ? `:${task.state.reason}` : ""}`)
			.join(",") || "none",
		submissions: inspection.submissions.map(settledText).join(",") || "none",
	};
}
