import { Decimal } from "../budget/decimal.ts";
import { type VendorPrice, VendorPriceBook } from "./vendor-ledger.ts";

/** The vendor that every priced model below belongs to. */
export const OPENAI_VENDOR = "openai";

/**
 * List prices in United States dollars per million tokens of the OpenAI models Chatticus calls. They come from
 * LiteLLM's public `model_prices_and_context_window.json` (openai entries, fetched 2026-10-11), a third-party catalog
 * and not OpenAI's own price page. The cached-input discount is not modelled because the ledger has one input counter,
 * so cost is a slight overestimate. The long-context tier of gpt-6-luna (input above 272000 tokens) is not modelled.
 */
export const OPENAI_MODEL_PRICES: Readonly<Record<string, { readonly input: string; readonly output: string }>> = {
	"gpt-6-luna": { input: "0.10", output: "0.50" },
	"gpt-5-nano": { input: "0.05", output: "0.40" },
	"gpt-5-mini": { input: "0.25", output: "2.00" },
};

/**
 * The price of one OpenAI model in the table.
 *
 * @param modelId OpenAI model id.
 * @throws Error When the table has no entry for the model.
 */
export function openAiModelPrice(modelId: string): VendorPrice {
	const entry = OPENAI_MODEL_PRICES[modelId];
	if (entry === undefined) throw new Error(`No OpenAI price is tabled for model ${modelId}.`);
	return { inputPerMillionUsd: Decimal.parse(entry.input), outputPerMillionUsd: Decimal.parse(entry.output) };
}

/**
 * The price book both production compositions (the turn executor and the front door with its model gateway) hand to the
 * spend ledger, so every recorded call of a tabled model gets dollars.
 */
export function defaultVendorPriceBook(): VendorPriceBook {
	const book = new VendorPriceBook();
	for (const modelId of Object.keys(OPENAI_MODEL_PRICES)) book.register(OPENAI_VENDOR, modelId, openAiModelPrice(modelId));
	return book;
}
