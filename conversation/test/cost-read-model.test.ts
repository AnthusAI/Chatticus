import { describe, expect, it } from "vitest";
import { costRowSchema, costTotalsSchema } from "@chatticus/host-protocol/costs";
import { Decimal } from "../src/budget/decimal.ts";
import {
	CostQueryError,
	costRowOf,
	csvLine,
	groupRows,
	indexRowOf,
	metricsOf,
	monthsEndingAt,
	monthsOfWindow,
	newestFirst,
	pageOfGroups,
	pageOfRows,
	plainDollars,
	resolveWindow,
	totalsOf,
	withoutAccountedGatewayRows,
	type IndexRow,
	type ModelEntry,
} from "../src/domain/costs.ts";

const entry = (overrides: Partial<ModelEntry> = {}): ModelEntry => ({
	model: "gpt-6-luna",
	calls: 1,
	inputTokens: 1000,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	outputTokens: 100,
	costUsd: Decimal.parse("0.00015"),
	unpricedCalls: 0,
	...overrides,
});

const row = (overrides: Partial<IndexRow> = {}): IndexRow => ({
	id: "turn#1",
	rowKind: "turn",
	turnId: "1",
	botId: "bot-a",
	channelId: "channel-a",
	memberId: "ryan",
	promptMessageSeq: 1,
	messageSeq: 2,
	ownerKind: "lambda",
	status: "completed",
	source: "session",
	estimated: false,
	recordedAt: "2026-08-31T06:00:00.000Z",
	updatedAt: "2026-08-31T06:00:01.000Z",
	priceBookId: "book",
	callId: null,
	responseIds: [],
	models: [entry()],
	...overrides,
});

describe("plainDollars", () => {
	it("gives one text to one amount whatever scale its additions had", () => {
		expect(plainDollars(Decimal.parse("0.00030"))).toBe("0.0003");
		expect(plainDollars(Decimal.parse("0.00015").add(Decimal.parse("0.00015")))).toBe("0.0003");
		expect(plainDollars(Decimal.parse("2.50"))).toBe("2.5");
		expect(plainDollars(Decimal.parse("3.000"))).toBe("3");
		expect(plainDollars(Decimal.zero())).toBe("0");
		expect(plainDollars(Decimal.parse("100"))).toBe("100");
	});
});

describe("totals", () => {
	it("leave the dollar total unknown when any call is unpriced, and keep the priced part apart", () => {
		const totals = totalsOf([row(), row({ id: "gateway#x", rowKind: "gateway_call", source: "gateway", models: [entry({ model: "gpt-9", costUsd: null, unpricedCalls: 1 })] })]);
		expect(totals.complete).toBe(false);
		expect(totals.cost_usd).toBeNull();
		expect(totals.unpriced_calls).toBe(1);
		expect(totals.priced_cost_usd).toBe("0.00015");
		expect(totals.by_model.find((model) => model.model === "gpt-9")).toMatchObject({ unpriced_calls: 1, priced_cost_usd: "0" });
	});

	it("are complete and exact when every call is priced", () => {
		const totals = totalsOf([row(), row({ id: "turn#2" })]);
		expect(totals).toMatchObject({ rows: 2, turns: 2, calls: 2, cost_usd: "0.0003", priced_cost_usd: "0.0003", complete: true });
	});

	it("count open turns and estimated gateway rows", () => {
		const totals = totalsOf([row({ status: "running" }), row({ id: "gateway#e", rowKind: "gateway_call", source: "gateway", estimated: true })]);
		expect(totals).toMatchObject({ open_turns: 1, gateway_rows: 1, estimated_rows: 1, turns: 1 });
	});

	it("have the shape the wire schema says", () => {
		expect(() => costTotalsSchema.parse(totalsOf([row()]))).not.toThrow();
		expect(() => costRowSchema.parse(costRowOf(row()))).not.toThrow();
	});
});

describe("groupRows", () => {
	const rows = [
		row(),
		row({ id: "turn#2", botId: "bot-b", memberId: "mia", models: [entry({ costUsd: Decimal.parse("0.00034") }), entry({ model: "gpt-5-nano", costUsd: Decimal.parse("0.00009") })] }),
		row({ id: "gateway#g", rowKind: "gateway_call", source: "gateway", botId: null, channelId: null, memberId: null }),
	];

	it("puts every row in exactly one group, rows without the dimension in the null group last", () => {
		const groups = groupRows(rows, "bot");
		expect(groups.map((group) => group.key)).toEqual(["bot-a", "bot-b", null]);
		const sum = groups.reduce((total, group) => total.add(Decimal.parse(group.totals.priced_cost_usd)), Decimal.zero());
		expect(plainDollars(sum)).toBe(totalsOf(rows).priced_cost_usd);
	});

	it("splits a row across the models that served it without changing the dollars or calls", () => {
		const groups = groupRows(rows, "model");
		expect(groups.map((group) => group.key)).toEqual(["gpt-5-nano", "gpt-6-luna"]);
		expect(groups.reduce((calls, group) => calls + group.totals.calls, 0)).toBe(totalsOf(rows).calls);
	});

	it("groups by month and day of the first record", () => {
		const spread = [row(), row({ id: "turn#9", recordedAt: "2026-09-02T06:00:00.000Z" })];
		expect(groupRows(spread, "month").map((group) => group.key)).toEqual(["2026-08", "2026-09"]);
		expect(groupRows(spread, "day").map((group) => group.key)).toEqual(["2026-08-31", "2026-09-02"]);
	});
});

describe("withoutAccountedGatewayRows", () => {
	it("drops a gateway row whose call a session row lists, and keeps the others", () => {
		const session = row({ responseIds: ["resp_1"] });
		const same = row({ id: "gateway#resp_1", rowKind: "gateway_call", source: "gateway", callId: "resp_1" });
		const other = row({ id: "gateway#resp_2", rowKind: "gateway_call", source: "gateway", callId: "resp_2" });
		expect(withoutAccountedGatewayRows([session, same, other]).map((kept) => kept.id)).toEqual(["turn#1", "gateway#resp_2"]);
	});
});

describe("indexRowOf", () => {
	it("reads a gateway item with its cached split and its estimate flag", () => {
		const parsed = indexRowOf({
			pk: { S: "anthus#cost#2026-08" },
			sk: { S: "gateway#resp_1" },
			source: { S: "gateway" },
			estimated: { BOOL: true },
			model: { S: "gpt-6-luna" },
			input_tokens: { N: "1000" },
			cached_input_tokens: { N: "400" },
			output_tokens: { N: "10" },
			cost_usd: { N: "0.001" },
			unpriced_calls: { N: "0" },
			recorded_at: { S: "2026-08-31T06:00:00.000Z" },
			call_id: { S: "resp_1" },
		});
		expect(parsed).toMatchObject({ rowKind: "gateway_call", source: "gateway", estimated: true, callId: "resp_1" });
		expect(parsed.models[0]).toMatchObject({ inputTokens: 600, cacheReadTokens: 400, outputTokens: 10, unpricedCalls: 0 });
	});

	it("reads an unpriced gateway item as an unpriced call with no dollars", () => {
		const parsed = indexRowOf({
			pk: { S: "p" },
			sk: { S: "gateway#x" },
			source: { S: "gateway" },
			model: { S: "gpt-9" },
			input_tokens: { N: "5" },
			output_tokens: { N: "1" },
			unpriced_calls: { N: "1" },
			recorded_at: { S: "2026-08-31T06:00:00.000Z" },
		});
		expect(parsed.models[0]).toMatchObject({ costUsd: null, unpricedCalls: 1 });
	});

	it("reads a session item per model, and a model with an unpriced call has no dollars", () => {
		const parsed = indexRowOf({
			pk: { S: "p" },
			sk: { S: "turn#1" },
			kind: { S: "turn" },
			recorded_at: { S: "2026-08-31T06:00:00.000Z" },
			by_model: {
				M: {
					"gpt-6-luna": { M: { calls: { N: "2" }, input_tokens: { N: "10" }, output_tokens: { N: "5" }, cost_usd: { N: "0.5" }, unpriced_calls: { N: "0" } } },
					"gpt-9": { M: { calls: { N: "1" }, input_tokens: { N: "3" }, unpriced_calls: { N: "1" } } },
				},
			},
		});
		expect(parsed.models.find((model) => model.model === "gpt-9")).toMatchObject({ costUsd: null, unpricedCalls: 1 });
		expect(parsed.models.find((model) => model.model === "gpt-6-luna")?.costUsd?.toString()).toBe("0.5");
	});
});

describe("windows", () => {
	const now = new Date("2026-08-31T06:00:00Z");

	it("default to the month so far for a rollup and to the whole lookback for a channel", () => {
		expect(resolveWindow({}, now, "month_to_date")).toEqual({ from: "2026-08-01", to: "2026-08-31" });
		expect(resolveWindow({}, now, "lookback")).toEqual({ from: "2023-09-01", to: "2026-08-31" });
		expect(resolveWindow({ to: "2026-05-17" }, now, "month_to_date")).toEqual({ from: "2026-05-01", to: "2026-05-17" });
	});

	it("refuse an impossible day, an inverted range and a start before the lookback", () => {
		expect(() => resolveWindow({ from: "2026-02-30" }, now, "month_to_date")).toThrow(CostQueryError);
		expect(() => resolveWindow({ from: "2026-08-02", to: "2026-08-01" }, now, "month_to_date")).toThrow(CostQueryError);
		expect(() => resolveWindow({ from: "2020-01-01" }, now, "month_to_date")).toThrow(CostQueryError);
	});

	it("list the months a window touches across a year end", () => {
		expect(monthsOfWindow({ from: "2025-11-15", to: "2026-02-01" })).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
		expect(monthsEndingAt(now, 3)).toEqual(["2026-08", "2026-07", "2026-06"]);
	});
});

describe("paging", () => {
	const rows = newestFirst([
		row({ id: "turn#a", recordedAt: "2026-08-31T06:00:00.000Z" }),
		row({ id: "turn#b", recordedAt: "2026-08-31T06:00:00.000Z" }),
		row({ id: "turn#c", recordedAt: "2026-08-30T06:00:00.000Z" }),
	]);

	it("visits every row once, newest first, ties broken on the id", () => {
		const seen: string[] = [];
		let cursor: string | undefined;
		do {
			const { page, next } = pageOfRows(rows, 1, cursor);
			seen.push(...page.map((item) => item.id));
			cursor = next ?? undefined;
		} while (cursor !== undefined);
		expect(seen).toEqual(["turn#b", "turn#a", "turn#c"]);
	});

	it("pages groups by key and refuses a cursor it did not issue", () => {
		const groups = groupRows([row({ botId: "bot-a" }), row({ id: "turn#2", botId: "bot-b" }), row({ id: "turn#3", botId: null })], "bot");
		const first = pageOfGroups(groups, 2, undefined);
		expect(first.page.map((group) => group.key)).toEqual(["bot-a", "bot-b"]);
		expect(pageOfGroups(groups, 2, first.next!).page.map((group) => group.key)).toEqual([null]);
		expect(() => pageOfGroups(groups, 2, "not-a-cursor")).toThrow(CostQueryError);
		expect(() => pageOfRows(rows, 1, Buffer.from("[1]").toString("base64url"))).toThrow(CostQueryError);
	});
});

describe("metricsOf", () => {
	it("normalizes by turns and calls, and leaves a figure null when it cannot be known", () => {
		const metrics = metricsOf(totalsOf([row({ models: [entry({ inputTokens: 1000, cacheReadTokens: 3000, calls: 2, costUsd: Decimal.parse("0.00049") })] })]));
		expect(metrics).toMatchObject({ turns: 1, cost_per_turn_usd: "0.00049", cost_per_call_usd: "0.000245", calls_per_turn: 2, cached_input_ratio: 0.75 });
		const unknown = metricsOf(totalsOf([row({ models: [entry({ costUsd: null, unpricedCalls: 1 })] })]));
		expect(unknown.cost_per_turn_usd).toBeNull();
		expect(unknown.cost_per_call_usd).toBeNull();
		expect(metricsOf(totalsOf([]))).toMatchObject({ turns: 0, cost_per_turn_usd: null, calls_per_turn: null, cached_input_ratio: null });
	});
});

describe("csvLine", () => {
	it("quotes a field that holds a comma, a quote or a line break, and writes null as nothing", () => {
		expect(csvLine(["a", 1, true, null, "b,c", 'say "hi"', "x\ny"])).toBe('a,1,true,,"b,c","say ""hi""","x\ny"\r\n');
	});
});
