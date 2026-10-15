import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_UNDERSTANDING_MODEL, UNDERSTANDING_VENDOR } from "../src/voice/understanding.ts";
import { defaultVendorPriceBook, OPENAI_MODEL_PRICES, OPENAI_PRICE_BOOK_ID, OPENAI_VENDOR } from "../src/ledger/vendor-prices.ts";
import { createOpenAiModels, DEFAULT_TURN_MODEL } from "../src/turn/openai-models.ts";

describe("the default vendor price table", () => {
	it("prices every tabled model, the turn model and the voice understanding model", () => {
		const book = defaultVendorPriceBook();
		for (const modelId of Object.keys(OPENAI_MODEL_PRICES)) {
			expect(book.lookup(OPENAI_VENDOR, modelId), modelId).not.toBeNull();
		}
		expect(book.lookup(DEFAULT_TURN_MODEL.provider, DEFAULT_TURN_MODEL.modelId)).not.toBeNull();
		expect(book.lookup(UNDERSTANDING_VENDOR, DEFAULT_UNDERSTANDING_MODEL)).not.toBeNull();
		expect(book.lookup(OPENAI_VENDOR, "unknown-model-id")).toBeNull();
	});

	it("agrees with every per-million rate and tier pi-ai lists for the same models", () => {
		const models = createOpenAiModels();
		const book = defaultVendorPriceBook();
		const rate = (value: { toString(): string } | undefined): number | undefined => (value === undefined ? undefined : Number(value.toString()));
		for (const modelId of Object.keys(OPENAI_MODEL_PRICES)) {
			const listed = models.getModel(OPENAI_VENDOR, modelId);
			const price = book.lookup(OPENAI_VENDOR, modelId);
			expect(listed, modelId).toBeDefined();
			expect(rate(price?.inputPerMillionUsd), modelId).toBe(listed?.cost.input);
			expect(rate(price?.outputPerMillionUsd), modelId).toBe(listed?.cost.output);
			expect(rate(price?.cacheReadPerMillionUsd), modelId).toBe(listed?.cost.cacheRead);
			expect(rate(price?.cacheWritePerMillionUsd), modelId).toBe(listed?.cost.cacheWrite);
			const listedTiers = listed?.cost.tiers ?? [];
			expect(price?.tiers?.length ?? 0, modelId).toBe(listedTiers.length);
			listedTiers.forEach((tier, index) => {
				const tabled = price?.tiers?.[index];
				expect(tabled?.inputTokensAbove).toBe(tier.inputTokensAbove);
				expect(rate(tabled?.inputPerMillionUsd)).toBe(tier.input);
				expect(rate(tabled?.outputPerMillionUsd)).toBe(tier.output);
				expect(rate(tabled?.cacheReadPerMillionUsd)).toBe(tier.cacheRead);
				expect(rate(tabled?.cacheWritePerMillionUsd)).toBe(tier.cacheWrite);
			});
		}
	});

	it("names its source and date in a version id", () => {
		expect(defaultVendorPriceBook().priceBookId).toBe(OPENAI_PRICE_BOOK_ID);
		expect(OPENAI_PRICE_BOOK_ID).toMatch(/^openai@\d{4}-\d{2}-\d{2}\+pi-ai-\d+\.\d+\.\d+$/);
	});

	it("is what both production compositions hand to the ledger", () => {
		for (const file of ["../src/lambdas/turn-executor.ts", "../src/lambdas/front-door-composition.ts"]) {
			const source = readFileSync(new URL(file, import.meta.url), "utf8");
			expect(source, file).toContain("defaultVendorPriceBook()");
			expect(source, file).not.toContain("new VendorPriceBook()");
		}
	});
});
