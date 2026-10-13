import { Decimal } from "../budget/decimal.ts";
import { type VendorPrice, VendorPriceBook, type VendorPriceTier } from "./price-book.ts";

/** The vendor that every priced model below belongs to. */
export const OPENAI_VENDOR = "openai";

/**
 * The version of the OpenAI price book: the source, the date the figures were read and the catalog release they were
 * read from. Every ledger row records it. Change the id whenever any figure below changes.
 */
export const OPENAI_PRICE_BOOK_ID = "openai@2026-10-13+pi-ai-1.0.2";

/** One long-context tier of a tabled model, in dollars per million tokens as decimal text. */
export type OpenAiTierEntry = {
	readonly inputTokensAbove: number;
	readonly input: string;
	readonly output: string;
	readonly cacheRead?: string;
	readonly cacheWrite?: string;
};

/**
 * One tabled model in dollars per million tokens as decimal text. A model whose source lists no cached-input rate
 * omits `cacheRead` or `cacheWrite`, and cached tokens of that model are then priced at its input rate and flagged
 * `uncached_fallback`. Every model below has all of its rates in the source.
 */
export type OpenAiModelPriceEntry = {
	readonly input: string;
	readonly output: string;
	readonly cacheRead?: string;
	readonly cacheWrite?: string;
	readonly tiers?: readonly OpenAiTierEntry[];
};

/**
 * List prices in United States dollars per million tokens of the OpenAI models Chatticus calls. They are copied from the
 * `openai` catalog that ships inside `@earendil-works/pi-ai` 1.0.2 (`dist/providers/data/openai.json`, read 2026-10-13),
 * the catalog the Pi harness itself prices with. It was not compared with OpenAI's own price page; a test pins this table
 * to the catalog so a pi-ai upgrade that changes a figure fails until the table and the version id are updated. The
 * long-context tier of gpt-6-luna applies when the input context exceeds 272000 tokens. A cache write rate of zero means
 * the vendor does not charge for cache writes of that model.
 */
export const OPENAI_MODEL_PRICES: Readonly<Record<string, OpenAiModelPriceEntry>> = {
	"gpt-6-luna": {
		input: "0.10",
		output: "0.50",
		cacheRead: "0.01",
		cacheWrite: "0.125",
		tiers: [{ inputTokensAbove: 272000, input: "0.2", output: "0.75", cacheRead: "0.02", cacheWrite: "0.25" }],
	},
	"gpt-5-nano": { input: "0.05", output: "0.40", cacheRead: "0.005", cacheWrite: "0" },
	"gpt-5-mini": { input: "0.25", output: "2.00", cacheRead: "0.025", cacheWrite: "0" },
};

const cacheRatesOf = (entry: { readonly cacheRead?: string; readonly cacheWrite?: string }) => ({
	...(entry.cacheRead === undefined ? {} : { cacheReadPerMillionUsd: Decimal.parse(entry.cacheRead) }),
	...(entry.cacheWrite === undefined ? {} : { cacheWritePerMillionUsd: Decimal.parse(entry.cacheWrite) }),
});

const tierOf = (entry: OpenAiTierEntry): VendorPriceTier => ({
	inputTokensAbove: entry.inputTokensAbove,
	inputPerMillionUsd: Decimal.parse(entry.input),
	outputPerMillionUsd: Decimal.parse(entry.output),
	...cacheRatesOf(entry),
});

/**
 * The price of one OpenAI model in the table.
 *
 * @param modelId OpenAI model id.
 * @throws Error When the table has no entry for the model.
 */
export function openAiModelPrice(modelId: string): VendorPrice {
	const entry = OPENAI_MODEL_PRICES[modelId];
	if (entry === undefined) throw new Error(`No OpenAI price is tabled for model ${modelId}.`);
	return {
		inputPerMillionUsd: Decimal.parse(entry.input),
		outputPerMillionUsd: Decimal.parse(entry.output),
		...cacheRatesOf(entry),
		...(entry.tiers === undefined ? {} : { tiers: entry.tiers.map(tierOf) }),
	};
}

/**
 * The price book both production compositions (the turn executor and the front door with its model gateway) hand to the
 * spend ledger, so every recorded call of a tabled model gets dollars.
 */
export function defaultVendorPriceBook(): VendorPriceBook {
	const book = new VendorPriceBook(OPENAI_PRICE_BOOK_ID);
	for (const modelId of Object.keys(OPENAI_MODEL_PRICES)) book.register(OPENAI_VENDOR, modelId, openAiModelPrice(modelId));
	return book;
}
