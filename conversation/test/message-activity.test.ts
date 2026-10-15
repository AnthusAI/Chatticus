import { describe, expect, it } from "vitest";
import {
	ACTIVITY_ITEM_LIMIT,
	ACTIVITY_RESPONSE_CHARACTER_BUDGET,
	capActivity,
	fitActivityBudget,
	type ToolActivityItem,
} from "../src/pi/message-activity.ts";
import { toolCallFields, toolResultFields } from "../src/turn/tool-event-fields.ts";

const LAMBDA_RESPONSE_LIMIT_BYTES = 6 * 1024 * 1024;

const largestItem = (index: number): ToolActivityItem => {
	const call = toolCallFields("run_terminal", `call-${index}`, { command: "c".repeat(5000) }, {});
	const result = toolResultFields("run_terminal", `call-${index}`, "o".repeat(50_000), false, null, null, {});
	return {
		call_id: call.callId,
		tool: call.tool,
		summary: call.summary,
		arguments: call.toolArguments,
		arguments_truncated: call.argumentsTruncated,
		ok: result.ok,
		result_summary: result.summary,
		output: result.output,
		output_truncated: result.outputTruncated,
		duration_ms: null,
	};
};

const largestMessageActivity = (): ToolActivityItem[] => capActivity(Array.from({ length: ACTIVITY_ITEM_LIMIT }, (_unused, index) => largestItem(index)), 80);

describe("capActivity", () => {
	it("keeps every item up to the limit", () => {
		const items = Array.from({ length: ACTIVITY_ITEM_LIMIT }, (_unused, index) => largestItem(index));
		expect(capActivity(items)).toHaveLength(ACTIVITY_ITEM_LIMIT);
		expect(capActivity(items).at(-1)?.tool).toBe("run_terminal");
	});

	it("keeps the first 49 and ends with an item that counts the rest", () => {
		const capped = largestMessageActivity();
		expect(capped).toHaveLength(ACTIVITY_ITEM_LIMIT);
		expect(capped[48]?.call_id).toBe("call-48");
		expect(capped[49]).toMatchObject({ tool: "more", summary: "31 more tool calls", ok: null, output: null, duration_ms: null });
	});
});

describe("fitActivityBudget", () => {
	it("keeps a message list of 100 full messages far below the Lambda response limit", () => {
		const activities = Array.from({ length: 100 }, () => largestMessageActivity());
		const unfitted = JSON.stringify(activities).length;
		expect(unfitted).toBeGreaterThan(LAMBDA_RESPONSE_LIMIT_BYTES);
		const fitted = fitActivityBudget(activities);
		const size = JSON.stringify(fitted.filter((activity) => activity !== undefined)).length;
		expect(size).toBeLessThanOrEqual(ACTIVITY_RESPONSE_CHARACTER_BUDGET);
		expect(size).toBeLessThan(LAMBDA_RESPONSE_LIMIT_BYTES / 2);
	});

	it("gives up the oldest messages first and keeps the newest", () => {
		const fitted = fitActivityBudget(Array.from({ length: 100 }, () => largestMessageActivity()));
		expect(fitted.at(-1)).toBeDefined();
		expect(fitted[0]).toBeUndefined();
	});

	it("leaves a message without activity without activity", () => {
		expect(fitActivityBudget([undefined, [largestItem(1)]])).toEqual([undefined, [largestItem(1)]]);
	});
});
