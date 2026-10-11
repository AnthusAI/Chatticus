import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_UNDERSTANDING_MODEL, UNDERSTANDING_VENDOR } from "../src/voice/understanding.ts";
import { defaultVendorPriceBook, OPENAI_MODEL_PRICES, OPENAI_VENDOR } from "../src/ledger/vendor-prices.ts";
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

	it("agrees with the per-million cost pi-ai lists for the same models", () => {
		const models = createOpenAiModels();
		const book = defaultVendorPriceBook();
		for (const modelId of Object.keys(OPENAI_MODEL_PRICES)) {
			const listed = models.getModel(OPENAI_VENDOR, modelId);
			const price = book.lookup(OPENAI_VENDOR, modelId);
			expect(listed, modelId).toBeDefined();
			expect(Number(price?.inputPerMillionUsd.toString()), modelId).toBe(listed?.cost.input);
			expect(Number(price?.outputPerMillionUsd.toString()), modelId).toBe(listed?.cost.output);
		}
	});

	it("is what both production compositions hand to the ledger", () => {
		for (const file of ["../src/lambdas/turn-executor.ts", "../src/lambdas/front-door-composition.ts"]) {
			const source = readFileSync(new URL(file, import.meta.url), "utf8");
			expect(source, file).toContain("defaultVendorPriceBook()");
			expect(source, file).not.toContain("new VendorPriceBook()");
		}
	});
});
