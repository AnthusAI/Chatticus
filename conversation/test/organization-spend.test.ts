import { describe, expect, it } from "vitest";
import type { BudgetRollupRow } from "../src/budget/models.ts";
import { Decimal } from "../src/budget/decimal.ts";
import {
	monthToDateCombinedSpendUsd,
	organizationComputerWorkPaused,
	requireValidMonthlyAwsSpendCeilingUsd,
	SPEND_CEILING_EXCEEDED_REASON,
	SPEND_CEILING_METER_UNAVAILABLE_REASON,
	type BudgetRollupReader,
} from "../src/domain/organization-spend.ts";
import type { Organization } from "../src/domain/organizations.ts";

function row(rollupDate: string, ceStatus: string, combined: string | null): BudgetRollupRow {
	return {
		tenantId: "t",
		environment: "development",
		rollupDate,
		awsCostUsd: null,
		vendorCostUsd: Decimal.zero(),
		combinedReportUsd: combined === null ? null : Decimal.parse(combined),
		ceStatus,
		alertEvents: [],
		updatedAt: "2026-08-31T06:00:00+00:00",
	};
}

function readerOf(rows: BudgetRollupRow[]): BudgetRollupReader {
	return {
		getBudgetRollupRow: async (_tenantId, _environment, rollupDate) =>
			rows.find((candidate) => candidate.rollupDate === rollupDate) ?? null,
	};
}

function organizationWithCeiling(ceiling: string | null): Organization {
	return {
		tenantId: "t",
		name: "Acme",
		status: "enabled",
		ownerUserId: "u",
		createdAt: new Date("2026-08-01T00:00:00Z"),
		awsAccountId: null,
		awsCrossAccountRole: null,
		awsExternalId: null,
		awsSetupPath: null,
		setupFeeCents: null,
		assistedSetupSession: false,
		monthlyAwsSpendCeilingUsd: ceiling === null ? null : Decimal.parse(ceiling),
	};
}

describe("month-to-date spend", () => {
	it("sums ok rows from the first of the month and ignores earlier months", async () => {
		const reader = readerOf([row("2026-07-31", "ok", "900"), row("2026-08-01", "ok", "10.50"), row("2026-08-03", "ok", "4")]);
		const meter = await monthToDateCombinedSpendUsd(reader, "t", "development", "2026-08-31");
		expect(meter.monthToDateUsd.toString()).toBe("14.50");
		expect(meter.meterUnknown).toBe(false);
	});

	it("marks the meter unknown for pending, error, unrecognised and combined-less rows", async () => {
		for (const unknown of [row("2026-08-02", "pending", null), row("2026-08-02", "error", null), row("2026-08-02", "weird", "1"), row("2026-08-02", "ok", null)]) {
			const meter = await monthToDateCombinedSpendUsd(readerOf([unknown]), "t", "development", "2026-08-31");
			expect(meter.meterUnknown).toBe(true);
		}
	});
});

describe("computer work pause", () => {
	it("is never paused without a ceiling", async () => {
		const pause = await organizationComputerWorkPaused(organizationWithCeiling(null), readerOf([row("2026-08-02", "error", null)]), "development", "2026-08-31");
		expect(pause).toEqual({ paused: false, reason: null });
	});

	it("pauses at the ceiling exactly and not below it", async () => {
		const atCeiling = await organizationComputerWorkPaused(organizationWithCeiling("250"), readerOf([row("2026-08-02", "ok", "250.00")]), "development", "2026-08-31");
		expect(atCeiling).toEqual({ paused: true, reason: SPEND_CEILING_EXCEEDED_REASON });
		const below = await organizationComputerWorkPaused(organizationWithCeiling("250"), readerOf([row("2026-08-02", "ok", "249.99")]), "development", "2026-08-31");
		expect(below).toEqual({ paused: false, reason: null });
	});

	it("pauses with the meter reason when the meter is unknown", async () => {
		const pause = await organizationComputerWorkPaused(organizationWithCeiling("250"), readerOf([row("2026-08-02", "pending", null)]), "development", "2026-08-31");
		expect(pause).toEqual({ paused: true, reason: SPEND_CEILING_METER_UNAVAILABLE_REASON });
	});
});

describe("ceiling validation", () => {
	it("requires a positive amount", () => {
		expect(() => requireValidMonthlyAwsSpendCeilingUsd(null)).toThrow("monthly_aws_spend_ceiling_usd is required at provisioning.");
		expect(() => requireValidMonthlyAwsSpendCeilingUsd(Decimal.zero())).toThrow("must be a positive USD amount");
		expect(requireValidMonthlyAwsSpendCeilingUsd(Decimal.parse("1")).toString()).toBe("1");
	});
});
