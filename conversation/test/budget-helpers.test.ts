import { describe, expect, it } from "vitest";
import { addDays, dayWrittenIn, firstDayOfMonth, pythonIsoUtc, utcDayOf } from "../src/budget/calendar.ts";
import { budgetRollupItem, budgetRollupFromItem, budgetThresholdStateKey } from "../src/budget/budget-store.ts";
import {
	AccountSpendUnreadableError,
	AwsCostExplorerReader,
	type CostExplorerApi,
	accountDayFromResponse,
} from "../src/budget/cost-explorer.ts";
import { Decimal } from "../src/budget/decimal.ts";
import { highestBandCrossed } from "../src/budget/runner.ts";

describe("Decimal", () => {
	it("preserves scale through addition and formatting", () => {
		expect(Decimal.parse("5.00").add(Decimal.parse("0.00004")).toString()).toBe("5.00004");
		expect(Decimal.parse("1.00").toString()).toBe("1.00");
		expect(Decimal.zero().add(Decimal.parse("45.00")).toString()).toBe("45.00");
	});

	it("compares by value regardless of scale", () => {
		expect(Decimal.parse("5.00").equals(Decimal.parse("5"))).toBe(true);
		expect(Decimal.parse("0").equals(Decimal.parse("0.00"))).toBe(true);
		expect(Decimal.parse("0.00004").compare(Decimal.parse("0.00003"))).toBe(1);
	});

	it("parses exponent notation and negatives", () => {
		expect(Decimal.parse("1E-7").toString()).toBe("0.0000001");
		expect(Decimal.parse("1E+3").toString()).toBe("1000");
		expect(Decimal.parse("-0.5").toString()).toBe("-0.5");
	});

	it("rejects text that is not a number", () => {
		expect(() => Decimal.parse("lots")).toThrow();
		expect(() => Decimal.parse("")).toThrow();
	});

	it("quantizes half to even", () => {
		expect(Decimal.parse("0.125").quantize(2).toString()).toBe("0.12");
		expect(Decimal.parse("0.135").quantize(2).toString()).toBe("0.14");
		expect(Decimal.parse("2").quantize(8).toString()).toBe("2.00000000");
	});
});

describe("calendar helpers", () => {
	it("formats UTC moments like Python isoformat", () => {
		expect(pythonIsoUtc(new Date("2026-08-31T06:00:00Z"))).toBe("2026-08-31T06:00:00+00:00");
		expect(pythonIsoUtc(new Date("2026-08-31T06:00:00.123Z"))).toBe("2026-08-31T06:00:00.123000+00:00");
	});

	it("does arithmetic on calendar days", () => {
		expect(addDays("2026-09-01", -1)).toBe("2026-08-31");
		expect(addDays("2026-08-31", 1)).toBe("2026-09-01");
		expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
		expect(firstDayOfMonth("2026-08-31")).toBe("2026-08-01");
		expect(utcDayOf(new Date("2026-08-31T23:59:59Z"))).toBe("2026-08-31");
	});

	it("reads the day a ledger timestamp was written in, without zone conversion", () => {
		expect(dayWrittenIn("2026-08-31T23:30:00-05:00")).toBe("2026-08-31");
	});
});

describe("highestBandCrossed", () => {
	const bands = [50, 80, 100];

	it("returns the top band crossed only", () => {
		expect(highestBandCrossed(Decimal.parse("55"), Decimal.parse("100"), bands)).toBe(50);
		expect(highestBandCrossed(Decimal.parse("85"), Decimal.parse("100"), bands)).toBe(80);
		expect(highestBandCrossed(Decimal.parse("100"), Decimal.parse("100"), bands)).toBe(100);
	});

	it("returns null below the first band", () => {
		expect(highestBandCrossed(Decimal.parse("49.99999999"), Decimal.parse("100"), bands)).toBeNull();
	});
});

function costExplorerApi(overrides: Partial<CostExplorerApi> & { calls?: unknown[] }): CostExplorerApi {
	return {
		getCostAndUsage: (input) => {
			overrides.calls?.push(input);
			return Promise.resolve({ ResultsByTime: [{ Groups: [] }], $metadata: {} });
		},
		listCostAllocationTags: () =>
			Promise.resolve({ CostAllocationTags: [{ TagKey: "chatticus:tenant", Type: "UserDefined", Status: "Active" }], $metadata: {} }),
		...overrides,
	};
}

describe("AwsCostExplorerReader", () => {
	const request = { environment: "development", rollupDate: "2026-08-31" };

	it("uses an exclusive end date", async () => {
		const calls: unknown[] = [];
		await new AwsCostExplorerReader(costExplorerApi({ calls })).dailyCostsByTenant(request);
		expect(calls[0]).toMatchObject({ TimePeriod: { Start: "2026-08-31", End: "2026-09-01" } });
	});

	it("treats empty results as pending", async () => {
		const api = costExplorerApi({ getCostAndUsage: () => Promise.resolve({ ResultsByTime: [], $metadata: {} }) });
		const result = await new AwsCostExplorerReader(api).dailyCostsByTenant(request);
		expect(result.pending).toBe(true);
		expect(result.costsByTenant.size).toBe(0);
	});

	it("treats empty groups as zero, not pending", async () => {
		const result = await new AwsCostExplorerReader(costExplorerApi({})).dailyCostsByTenant(request);
		expect(result.pending).toBe(false);
		expect(result.costsByTenant.size).toBe(0);
		expect(result.tenantTagActive).toBe(true);
	});

	it("reads tenant costs from the tag groups", async () => {
		const api = costExplorerApi({
			getCostAndUsage: () =>
				Promise.resolve({
					ResultsByTime: [
						{
							Groups: [
								{ Keys: ["chatticus:tenant$anthus"], Metrics: { UnblendedCost: { Amount: "5.25" } } },
								{ Keys: ["chatticus:tenant$"], Metrics: { UnblendedCost: { Amount: "1.00" } } },
								{ Keys: ["other:tag$x"], Metrics: { UnblendedCost: { Amount: "9.00" } } },
							],
						},
					],
					$metadata: {},
				}),
		});
		const result = await new AwsCostExplorerReader(api).dailyCostsByTenant(request);
		expect(result.costsByTenant.get("anthus")?.toString()).toBe("5.25");
		expect(result.costsByTenant.get("")?.toString()).toBe("1.00");
		expect(result.costsByTenant.has("x")).toBe(false);
	});

	it("reads the tenant tag as inactive when Cost Explorer does not list it", async () => {
		const api = costExplorerApi({ listCostAllocationTags: () => Promise.resolve({ CostAllocationTags: [], $metadata: {} }) });
		expect((await new AwsCostExplorerReader(api).dailyCostsByTenant(request)).tenantTagActive).toBe(false);
	});

	it("reads the tenant tag as inactive when the lookup fails", async () => {
		const api = costExplorerApi({ listCostAllocationTags: () => Promise.reject(new Error("AccessDeniedException")) });
		expect((await new AwsCostExplorerReader(api).dailyCostsByTenant(request)).tenantTagActive).toBe(false);
	});
});

describe("accountDayFromResponse", () => {
	it("reads the total unblended cost", () => {
		const day = accountDayFromResponse({
			ResultsByTime: [{ Total: { UnblendedCost: { Amount: "22.3487" } } }],
			$metadata: {},
		});
		expect(day.pending).toBe(false);
		expect(day.totalUsd?.toString()).toBe("22.3487");
	});

	it("treats no results as pending, not zero", () => {
		const day = accountDayFromResponse({ ResultsByTime: [], $metadata: {} });
		expect(day.pending).toBe(true);
		expect(day.totalUsd).toBeNull();
	});

	it("treats a malformed total as unreadable", () => {
		expect(() => accountDayFromResponse({ ResultsByTime: [{ Total: {} }], $metadata: {} })).toThrow(
			AccountSpendUnreadableError,
		);
	});
});

describe("frozen rollup item layout shared with the Python readers", () => {
	const row = {
		tenantId: "anthus",
		environment: "development",
		rollupDate: "2026-08-31",
		awsCostUsd: Decimal.parse("5.00"),
		vendorCostUsd: Decimal.parse("0.00004"),
		combinedReportUsd: Decimal.parse("5.00004"),
		ceStatus: "ok",
		alertEvents: [{ source: "aws_budget", firedAt: "2026-08-31T06:00:00+00:00", detail: "{}" }],
		updatedAt: "2026-08-31T06:00:00+00:00",
	};

	it("writes the exact attribute names, types and keys", () => {
		expect(budgetRollupItem(row)).toEqual({
			pk: { S: "anthus#budget_rollup" },
			sk: { S: "development#day#2026-08-31" },
			tenant_id: { S: "anthus" },
			environment: { S: "development" },
			rollup_date: { S: "2026-08-31" },
			vendor_cost_usd: { N: "0.00004" },
			ce_status: { S: "ok" },
			updated_at: { S: "2026-08-31T06:00:00+00:00" },
			alert_events: { S: '[{"source":"aws_budget","fired_at":"2026-08-31T06:00:00+00:00","detail":"{}"}]' },
			aws_cost_usd: { N: "5.00" },
			combined_report_usd: { N: "5.00004" },
		});
	});

	it("omits null cost attributes rather than writing nulls", () => {
		const item = budgetRollupItem({ ...row, awsCostUsd: null, combinedReportUsd: null });
		expect("aws_cost_usd" in item).toBe(false);
		expect("combined_report_usd" in item).toBe(false);
	});

	it("round-trips through the item", () => {
		const read = budgetRollupFromItem(budgetRollupItem(row));
		expect(read.alertEvents).toEqual(row.alertEvents);
		expect(read.combinedReportUsd?.toString()).toBe("5.00004");
	});

	it("keys threshold state under the account partition", () => {
		expect(budgetThresholdStateKey("development")).toEqual({
			pk: "__account__#budget_rollup",
			sk: "development#threshold_state",
		});
	});
});
