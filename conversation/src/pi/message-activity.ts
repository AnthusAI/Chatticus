import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Cursor, type EntryId, ROOT_CONVERSATION_ID, type Storage } from "@earendil-works/pi-durable";
import type { ToolEventArguments } from "../domain/turns.ts";
import { textOf, toolCallsOf } from "../turn/event-stream.ts";
import { toolCallFields, toolResultFields } from "../turn/tool-event-fields.ts";

/** The most tool calls one listed message carries; a longer turn keeps the first of them and one counting item. */
export const ACTIVITY_ITEM_LIMIT = 50;

/** The most serialized characters of activity one message list carries; older messages give up their activity first. */
export const ACTIVITY_RESPONSE_CHARACTER_BUDGET = 3_000_000;

const ENTRY_PAGE_SIZE = 200;

/** One tool call of a turn as the message list shows it: the `tool.call` and `tool.result` event fields in one item. */
export type ToolActivityItem = {
	call_id: string;
	tool: string;
	summary: string;
	arguments: ToolEventArguments;
	arguments_truncated: boolean;
	ok: boolean | null;
	result_summary: string | null;
	output: string | null;
	output_truncated: boolean;
	duration_ms: number | null;
};

type RecordedCall = { id: string; item: ToolActivityItem; writtenBytes: number | null };

const countingItem = (omitted: number): ToolActivityItem => ({
	call_id: "more",
	tool: "more",
	summary: `${omitted} more tool calls`,
	arguments: {},
	arguments_truncated: false,
	ok: null,
	result_summary: null,
	output: null,
	output_truncated: false,
	duration_ms: null,
});

/**
 * Keep at most the first {@link ACTIVITY_ITEM_LIMIT} items; when there are more, keep the first one fewer and end with
 * an item that counts the calls left out.
 *
 * @param items The first tool calls of a turn, in order; at least {@link ACTIVITY_ITEM_LIMIT} of them when there are more.
 * @param totalCalls How many tool calls the turn made.
 * @returns The bounded list.
 */
export function capActivity(items: readonly ToolActivityItem[], totalCalls: number = items.length): ToolActivityItem[] {
	if (totalCalls <= ACTIVITY_ITEM_LIMIT) return [...items];
	const kept = ACTIVITY_ITEM_LIMIT - 1;
	return [...items.slice(0, kept), countingItem(totalCalls - kept)];
}

/**
 * Give up the activity of the oldest messages until the serialized activity of the whole list fits the budget. The
 * newest messages, which a reader looks at first, keep theirs.
 *
 * @param activities The activity of each listed message in list order, undefined where a message has none.
 * @param budget The most serialized characters all the activity may take together.
 * @returns The activity to attach to each message, in the same order.
 */
export function fitActivityBudget(
	activities: ReadonlyArray<ToolActivityItem[] | undefined>,
	budget: number = ACTIVITY_RESPONSE_CHARACTER_BUDGET,
): Array<ToolActivityItem[] | undefined> {
	const fitted: Array<ToolActivityItem[] | undefined> = activities.map(() => undefined);
	let remaining = budget;
	for (let index = activities.length - 1; index >= 0; index -= 1) {
		const activity = activities[index];
		if (activity === undefined) continue;
		const size = JSON.stringify(activity).length;
		if (size > remaining) continue;
		remaining -= size;
		fitted[index] = activity;
	}
	return fitted;
}

/**
 * Read the tool activity of one turn from the session, without owning it: every tool call of the entries after
 * `afterEntryId` up to and including `answerEntryId`, each with its result when the session recorded one. Arguments and
 * output are sanitized by the same functions that sanitize the live `tool.call` and `tool.result` events.
 *
 * @param storage A storage opened without a fence.
 * @param afterEntryId The entry id the turn starts after (exclusive); 0 for the start of the session.
 * @param answerEntryId The entry id of the turn's final answer (inclusive).
 * @param context Cancellation context.
 * @returns The bounded activity items in call order; empty when the turn used no tool.
 */
export async function readTurnActivity(
	storage: Storage,
	afterEntryId: number,
	answerEntryId: number,
	context: Context = BACKGROUND_CONTEXT,
): Promise<ToolActivityItem[]> {
	const newestFirst = [];
	let cursor: Cursor | undefined;
	do {
		const page = await storage.scanEntries(
			{ conversationId: ROOT_CONVERSATION_ID, minEntryId: (afterEntryId + 1) as EntryId, maxEntryId: answerEntryId as EntryId },
			ENTRY_PAGE_SIZE,
			cursor,
			context,
		);
		newestFirst.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	const calls = new Map<string, RecordedCall>();
	let totalCalls = 0;
	for (const entry of newestFirst.reverse()) {
		const message = entry.model?.[0];
		if (message?.role === "assistant") {
			for (const call of toolCallsOf(message.content)) {
				totalCalls += 1;
				if (calls.size >= ACTIVITY_ITEM_LIMIT) continue;
				const fields = toolCallFields(call.name, call.id, call.arguments);
				calls.set(call.id, {
					id: call.id,
					writtenBytes: fields.writtenBytes,
					item: {
						call_id: fields.callId,
						tool: fields.tool,
						summary: fields.summary,
						arguments: fields.toolArguments,
						arguments_truncated: fields.argumentsTruncated,
						ok: null,
						result_summary: null,
						output: null,
						output_truncated: false,
						duration_ms: null,
					},
				});
			}
		} else if (message?.role === "toolResult") {
			const recorded = calls.get(message.toolCallId);
			if (recorded === undefined) continue;
			const fields = toolResultFields(
				recorded.item.tool,
				recorded.id,
				textOf(message.content),
				message.isError === true,
				recorded.writtenBytes,
				null,
			);
			recorded.item.ok = fields.ok;
			recorded.item.result_summary = fields.summary;
			recorded.item.output = fields.output;
			recorded.item.output_truncated = fields.outputTruncated;
		}
	}
	return capActivity([...calls.values()].map((call) => call.item), totalCalls);
}
