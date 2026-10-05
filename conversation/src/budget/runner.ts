import type { BudgetAlertsPublisher } from "./budget-alerts.ts";
import type { BudgetStore } from "./budget-store.ts";
import { dayWrittenIn, firstDayOfMonth, pythonIsoUtc } from "./calendar.ts";
import {
	AccountSpendUnreadableError,
	type AccountSpendReader,
	type CostExplorerDayResult,
	type CostExplorerReader,
} from "./cost-explorer.ts";
import { Decimal } from "./decimal.ts";
import {
	BILLED_VIA_VENDOR,
	CE_STATUS_ERROR,
	CE_STATUS_OK,
	CE_STATUS_PENDING,
	DEFAULT_THRESHOLD_BANDS,
	type Organization,
} from "./models.ts";

export interface DailyRollupRequest {
	readonly store: BudgetStore;
	readonly costExplorer: CostExplorerReader;
	readonly accountSpend: AccountSpendReader | null;
	readonly alerts: BudgetAlertsPublisher | null;
	readonly environment: string;
	readonly rollupDate: string;
	readonly monthlyLimitUsd: Decimal;
	readonly now: Date;
	readonly thresholdBands?: readonly number[];
}

/** Write org-environment-day rows and publish vendor threshold alerts once. */
export async function runDailyRollup(request: DailyRollupRequest): Promise<void> {
	const { store, environment, rollupDate } = request;
	const ceResult = await request.costExplorer.dailyCostsByTenant({ environment, rollupDate });
	const updatedAt = pythonIsoUtc(request.now);
	for (const organization of await store.listEnabledOrganizations()) {
		const vendorCostUsd = await vendorDailyTotal(store, organization.tenantId, rollupDate);
		const [awsCostUsd, ceStatus] = await awsSpendFor(organization, ceResult, request.accountSpend, rollupDate);
		const existing = await store.getBudgetRollupRow(organization.tenantId, environment, rollupDate);
		await store.putBudgetRollupRow({
			tenantId: organization.tenantId,
			environment,
			rollupDate,
			awsCostUsd,
			vendorCostUsd,
			combinedReportUsd: awsCostUsd === null ? null : awsCostUsd.add(vendorCostUsd),
			ceStatus,
			alertEvents: existing?.alertEvents ?? [],
			updatedAt,
		});
	}
	await maybePublishVendorThreshold(request);
}

/**
 * Return one organization's AWS dollars and the meter status for the day.
 *
 * An organization in its own AWS account is read through that account. A
 * hosted organization is read by its tenant tag, which Cost Explorer only
 * reports once the tag is an active cost allocation tag. A read that fails, or
 * a tag that is not active, is `error`, never zero: an unreadable meter must
 * not look like an organization that spent nothing.
 */
async function awsSpendFor(
	organization: Organization,
	ceResult: CostExplorerDayResult,
	accountSpend: AccountSpendReader | null,
	rollupDate: string,
): Promise<[Decimal | null, string]> {
	if (organization.awsCrossAccountRole !== null && organization.awsCrossAccountRole !== "") {
		if (accountSpend === null) {
			return [null, CE_STATUS_ERROR];
		}
		try {
			const day = await accountSpend.dailyTotal({ organization, rollupDate });
			if (day.pending || day.totalUsd === null) {
				return [null, CE_STATUS_PENDING];
			}
			return [day.totalUsd, CE_STATUS_OK];
		} catch (error) {
			if (error instanceof AccountSpendUnreadableError) {
				console.warn(`account_spend_unreadable tenant_id=${organization.tenantId} reason=${error.message}`);
				return [null, CE_STATUS_ERROR];
			}
			throw error;
		}
	}
	if (ceResult.pending) {
		return [null, CE_STATUS_PENDING];
	}
	if (!ceResult.tenantTagActive) {
		console.warn(
			`tenant_cost_tag_inactive tenant_id=${organization.tenantId} ` +
				"reason=chatticus:tenant is not an active cost allocation tag",
		);
		return [null, CE_STATUS_ERROR];
	}
	return [ceResult.costsByTenant.get(organization.tenantId) ?? Decimal.zero(), CE_STATUS_OK];
}

async function vendorDailyTotal(store: BudgetStore, tenantId: string, rollupDate: string): Promise<Decimal> {
	let total = Decimal.zero();
	for (const row of await store.listVendorLedgerRowsForTenant(tenantId)) {
		if (dayWrittenIn(row.recordedAt) !== rollupDate || row.billedVia !== BILLED_VIA_VENDOR || row.costUsd === null) {
			continue;
		}
		total = total.add(row.costUsd);
	}
	return total;
}

async function vendorMonthToDateTotal(store: BudgetStore, rollupDate: string): Promise<Decimal> {
	const monthStart = firstDayOfMonth(rollupDate);
	let total = Decimal.zero();
	for (const organization of await store.listEnabledOrganizations()) {
		for (const row of await store.listVendorLedgerRowsForTenant(organization.tenantId)) {
			const rowDay = dayWrittenIn(row.recordedAt);
			if (rowDay < monthStart || rowDay > rollupDate) {
				continue;
			}
			if (row.billedVia !== BILLED_VIA_VENDOR || row.costUsd === null) {
				continue;
			}
			total = total.add(row.costUsd);
		}
	}
	return total;
}

async function maybePublishVendorThreshold(request: DailyRollupRequest): Promise<void> {
	const { store, alerts, environment, rollupDate, monthlyLimitUsd } = request;
	if (alerts === null || !monthlyLimitUsd.isPositive()) {
		return;
	}
	const vendorMtd = await vendorMonthToDateTotal(store, rollupDate);
	const crossedBand = highestBandCrossed(vendorMtd, monthlyLimitUsd, request.thresholdBands ?? DEFAULT_THRESHOLD_BANDS);
	if (crossedBand === null) {
		return;
	}
	const state = await store.getBudgetThresholdState(environment);
	if (crossedBand <= (state?.lastNotifiedBand ?? 0)) {
		return;
	}
	await alerts.publishThresholdCrossing({
		environment,
		thresholdPercent: crossedBand,
		vendorMtdUsd: vendorMtd,
		monthlyLimitUsd,
		rollupDate,
	});
	await store.putBudgetThresholdState({
		environment,
		lastNotifiedBand: crossedBand,
		updatedAt: pythonIsoUtc(request.now),
	});
}

/** The highest band whose share of the monthly limit the spend has reached, or null. */
export function highestBandCrossed(
	spend: Decimal,
	monthlyLimitUsd: Decimal,
	thresholdBands: readonly number[],
): number | null {
	let crossed: number | null = null;
	for (const band of [...thresholdBands].sort((left, right) => left - right)) {
		const thresholdAmount = monthlyLimitUsd.multiplyByInteger(band).divideByPowerOfTen(2).quantize(8);
		if (spend.compare(thresholdAmount) >= 0) {
			crossed = band;
		}
	}
	return crossed;
}
