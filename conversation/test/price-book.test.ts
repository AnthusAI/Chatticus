import { describe, expect, it } from "vitest";
import { Decimal } from "../src/budget/decimal.ts";
import {
	contextTokensOf,
	PRICED_WITH_LIST,
	PRICED_WITH_LONG_CONTEXT_TIER,
	PRICED_WITH_UNCACHED_FALLBACK,
	priceCall,
	priceCalls,
	UnpricedModelError,
	VendorPriceBook,
} from "../src/ledger/price-book.ts";
import { defaultVendorPriceBook, OPENAI_VENDOR } from "../src/ledger/vendor-prices.ts";

const call = (model: string, inputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, outputTokens: number) => ({
	vendor: OPENAI_VENDOR,
	model,
	inputTokens,
	cacheReadTokens,
	cacheWriteTokens,
	outputTokens,
});

describe("pricing one call from the stored counters", () => {
	const book = defaultVendorPriceBook();
	const table: ReadonlyArray<readonly [string, ReturnType<typeof call>, string, readonly string[]]> = [
		["uncached input and output at base rates", call("gpt-6-luna", 1000, 0, 0, 100), "0.00015", [PRICED_WITH_LIST]],
		["cache reads at the tier cache read rate", call("gpt-6-luna", 0, 1000000, 0, 0), "0.02", [PRICED_WITH_LONG_CONTEXT_TIER]],
		["cache reads below the threshold at the cache read rate", call("gpt-6-luna", 0, 100000, 0, 0), "0.001", [PRICED_WITH_LIST]],
		["cache writes at the cache write rate", call("gpt-6-luna", 0, 0, 100000, 0), "0.0125", [PRICED_WITH_LIST]],
		["a free cache write rate costs nothing", call("gpt-5-nano", 0, 0, 1000000, 0), "0", [PRICED_WITH_LIST]],
		["a context exactly at the threshold stays at base rates", call("gpt-6-luna", 272000, 0, 0, 0), "0.0272", [PRICED_WITH_LIST]],
		["a context of the threshold plus one token takes the tier", call("gpt-6-luna", 272001, 0, 0, 0), "0.0544002", [PRICED_WITH_LONG_CONTEXT_TIER]],
		["cached tokens count toward the context size", call("gpt-6-luna", 1, 272000, 0, 0), "0.0054402", [PRICED_WITH_LONG_CONTEXT_TIER]],
		["a model without tiers never takes a tier", call("gpt-5-mini", 399999, 0, 0, 0), "0.09999975", [PRICED_WITH_LIST]],
	];
	it.each(table)("%s", (_name, subject, expected, labels) => {
		const priced = priceCall(book, subject);
		expect(priced.costUsd.equals(Decimal.parse(expected)), `${priced.costUsd.toString()} vs ${expected}`).toBe(true);
		expect(priced.pricedWith).toEqual(labels);
	});

	it("sizes the context as the three input counters together", () => {
		expect(contextTokensOf(call("gpt-6-luna", 1, 2, 3, 99))).toBe(6);
	});

	it("refuses to price an unknown model instead of pricing it as zero", () => {
		expect(() => priceCall(book, call("gpt-9-unpriced", 1, 0, 0, 1))).toThrow(UnpricedModelError);
	});
});

describe("a price without cache rates", () => {
	const bareBook = (): VendorPriceBook => {
		const book = new VendorPriceBook("test-book");
		book.register(OPENAI_VENDOR, "bare", { inputPerMillionUsd: Decimal.parse("2"), outputPerMillionUsd: Decimal.parse("4") });
		return book;
	};

	it("prices cached tokens at the input rate and says so", () => {
		const priced = priceCall(bareBook(), call("bare", 1000, 500, 500, 0));
		expect(priced.costUsd.equals(Decimal.parse("0.004"))).toBe(true);
		expect(priced.pricedWith).toEqual([PRICED_WITH_LIST, PRICED_WITH_UNCACHED_FALLBACK]);
	});

	it("does not flag a call that used no cache", () => {
		expect(priceCall(bareBook(), call("bare", 1000, 0, 0, 0)).pricedWith).toEqual([PRICED_WITH_LIST]);
	});
});

describe("pricing the calls of a turn", () => {
	const book = defaultVendorPriceBook();

	it("prices each call by its own model", () => {
		const priced = priceCalls(book, [call("gpt-6-luna", 1000, 0, 0, 100), call("gpt-5-nano", 1000, 0, 0, 100)]);
		expect(priced.costUsd?.equals(Decimal.parse("0.00024"))).toBe(true);
		expect(priced.models).toEqual(["gpt-5-nano", "gpt-6-luna"]);
		expect(priced.unpricedCalls).toBe(0);
	});

	it("makes the total unknown when any call is unpriced", () => {
		const priced = priceCalls(book, [call("gpt-6-luna", 1000, 0, 0, 100), call("gpt-9-unpriced", 1000, 0, 0, 100)]);
		expect(priced.costUsd).toBeNull();
		expect(priced.unpricedCalls).toBe(1);
	});
});
