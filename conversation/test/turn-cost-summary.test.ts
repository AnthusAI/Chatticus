import { describe, expect, it } from "vitest";
import { callCostKeyOf, type ModelCallCost } from "../src/ledger/call-cost.ts";
import { costTurnIndexKey, summarizeTurnCost } from "../src/ledger/turn-cost.ts";

const recordOf = (overrides: Partial<ModelCallCost>): ModelCallCost => ({
	version: 1,
	filled: true,
	conversationId: "root",
	entryId: 1,
	kind: "turn_round",
	turnId: "turn-1",
	round: 1,
	provider: "openai",
	model: "gpt-6-luna",
	responseId: null,
	inputTokens: 1000,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	outputTokens: 100,
	reasoningTokens: 0,
	contextTokens: 1000,
	priceBookId: "book-1",
	tier: "standard",
	pricedWith: ["list"],
	inputRatePerMillionUsd: "0.10",
	outputRatePerMillionUsd: "0.50",
	costUsd: "0.00015",
	unpriced: false,
	providerCostEstimateUsd: 0,
	recordedAt: "2026-10-13T10:00:00.000Z",
	...overrides,
});

describe("the key of a cost record", () => {
	it("is the entry and nothing else, so the same entry always has the same key", () => {
		expect(callCostKeyOf(42)).toBe("entry-42");
		expect(callCostKeyOf(42)).toBe(callCostKeyOf(42));
	});
});

describe("the turn index key", () => {
	it("partitions by tenant and month and sorts by turn", () => {
		expect(costTurnIndexKey("anthus", "2026-10", "t9")).toEqual({ pk: "anthus#cost#2026-10", sk: "turn#t9" });
	});
});

describe("summarizing the cost records of a turn", () => {
	it("is null for a turn with no record", () => {
		expect(summarizeTurnCost([])).toBeNull();
	});

	it("sums tokens and dollars and counts context input with the cached tokens", () => {
		const summary = summarizeTurnCost([
			recordOf({ entryId: 3, inputTokens: 2000, cacheReadTokens: 4000, outputTokens: 200, costUsd: "0.00034" }),
			recordOf({ entryId: 1 }),
		])!;
		expect(summary.recordCount).toBe(2);
		expect(summary.inputTokens).toBe(3000);
		expect(summary.contextInputTokens).toBe(7000);
		expect(summary.outputTokens).toBe(300);
		expect(summary.costUsd?.toString()).toBe("0.00049");
		expect(summary.model).toBe("gpt-6-luna");
	});

	it("makes the dollars unknown when any call is unpriced, never the sum of the priced part", () => {
		const summary = summarizeTurnCost([
			recordOf({ entryId: 1 }),
			recordOf({ entryId: 2, model: "gpt-9-unpriced", costUsd: null, unpriced: true, tier: null, pricedWith: [] }),
		])!;
		expect(summary.costUsd).toBeNull();
		expect(summary.unpricedCalls).toBe(1);
		expect(summary.models).toEqual(["gpt-6-luna", "gpt-9-unpriced"]);
		expect(summary.byModel.get("gpt-6-luna")?.costUsd?.toString()).toBe("0.00015");
		expect(summary.byModel.get("gpt-9-unpriced")?.costUsd).toBeNull();
	});

	it("names the first call's model and rates and the earliest record time", () => {
		const summary = summarizeTurnCost([
			recordOf({ entryId: 5, model: "gpt-5-nano", recordedAt: "2026-10-13T10:05:00.000Z" }),
			recordOf({ entryId: 2, recordedAt: "2026-10-13T10:01:00.000Z" }),
		])!;
		expect(summary.model).toBe("gpt-6-luna");
		expect(summary.inputRatePerMillionUsd?.toString()).toBe("0.10");
		expect(summary.firstRecordedAt).toBe("2026-10-13T10:01:00.000Z");
	});
});
