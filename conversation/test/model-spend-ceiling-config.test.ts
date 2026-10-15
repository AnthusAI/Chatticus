import { describe, expect, it } from "vitest";
import {
	DEFAULT_MONTHLY_MODEL_SPEND_CEILING_USD,
	MONTHLY_MODEL_SPEND_CEILING_VARIABLE,
	monthlyModelSpendCeilingUsdFrom,
} from "../src/ledger/model-spend.ts";

describe("monthlyModelSpendCeilingUsdFrom", () => {
	it("is the named default when the variable is unset or empty", () => {
		expect(monthlyModelSpendCeilingUsdFrom({}).toString()).toBe(DEFAULT_MONTHLY_MODEL_SPEND_CEILING_USD);
		expect(monthlyModelSpendCeilingUsdFrom({ [MONTHLY_MODEL_SPEND_CEILING_VARIABLE]: "" }).toString()).toBe(DEFAULT_MONTHLY_MODEL_SPEND_CEILING_USD);
	});

	it("is the configured amount when the variable is set", () => {
		expect(monthlyModelSpendCeilingUsdFrom({ [MONTHLY_MODEL_SPEND_CEILING_VARIABLE]: "100" }).toString()).toBe("100");
	});

	it("refuses an amount that is not positive or not a number rather than removing the limit", () => {
		expect(() => monthlyModelSpendCeilingUsdFrom({ [MONTHLY_MODEL_SPEND_CEILING_VARIABLE]: "0" })).toThrow(/positive/);
		expect(() => monthlyModelSpendCeilingUsdFrom({ [MONTHLY_MODEL_SPEND_CEILING_VARIABLE]: "-5" })).toThrow(/positive/);
		expect(() => monthlyModelSpendCeilingUsdFrom({ [MONTHLY_MODEL_SPEND_CEILING_VARIABLE]: "lots" })).toThrow(/Not a decimal/);
	});
});
