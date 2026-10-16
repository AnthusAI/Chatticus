import type { BudgetAlertsPublisher } from "./budget-alerts.ts";
import type { BudgetStore } from "./budget-store.ts";
import { dayWrittenIn, firstDayOfMonth, pythonIsoUtc } from "./calendar.ts";
import type { HostedComputerSpendReader } from "./computer-runtime.ts";
import { AccountSpendUnreadableError, type AccountSpendReader } from "./cost-explorer.ts";
import { Decimal } from "./decimal.ts";
import type { ObservationReconciler } from "../ledger/reconcile.ts";
import {
	BILLED_VIA_VENDOR,
	CE_STATUS_ERROR,
	CE_STATUS_OK,
	CE_STATUS_PENDING,
	DEFAULT_THRESHOLD_BANDS,
	type Organization,
	type VendorLedgerRow,
} from "./models.ts";

const GATEWAY_SOURCE = "gateway";

export interface DailyRollupRequest {
	readonly store: BudgetStore;
	/** Prices the computer runtime the control plane recorded for organizations hosted in the deployment account. */
	readonly hostedComputerSpend: HostedComputerSpendReader;
	/** Reads an organization in its own AWS account through that account; null makes such an organization unreadable. */
	readonly accountSpend: AccountSpendReader | null;
	readonly alerts: BudgetAlertsPublisher | null;
	/** Reconciles each organization's gateway observations against its session records before its spend is summed; null skips it. */
	readonly reconciler: ObservationReconciler | null;
	readonly environment: string;
	readonly rollupDate: string;
	readonly monthlyLimitUsd: Decimal;
	readonly now: Date;
	readonly thresholdBands?: readonly number[];
}

/**
 * Write org-environment-day rows and publish vendor threshold alerts once. Each organization's gateway observations are
 * reconciled first, so a call the vendor answered and the session never committed is in the day's dollars and a call the
 * session did record is not counted a second time. Calls the price book could not price are counted on the row
 * (`unpriced_calls`) and logged, never skipped without trace.
 */
export async function runDailyRollup(request: DailyRollupRequest): Promise<void> {
	const { store, environment, rollupDate } = request;
	const updatedAt = pythonIsoUtc(request.now);
	for (const organization of await store.listEnabledOrganizations()) {
		await request.reconciler?.reconcileTenant(organization.tenantId);
		const { total: vendorCostUsd, unpricedCalls } = await vendorDailyTotal(store, organization.tenantId, rollupDate);
		if (unpricedCalls > 0) {
			console.warn(`vendor_cost_unpriced_calls tenant_id=${organization.tenantId} rollup_date=${rollupDate} unpriced_calls=${unpricedCalls}`);
		}
		const [awsCostUsd, ceStatus] = await awsSpendFor(organization, request, rollupDate);
		const existing = await store.getBudgetRollupRow(organization.tenantId, environment, rollupDate);
		await store.putBudgetRollupRow({
			tenantId: organization.tenantId,
			environment,
			rollupDate,
			awsCostUsd,
			vendorCostUsd,
			unpricedCalls,
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
 * An organization in its own AWS account is read through that account. An organization hosted in the deployment
 * account is priced from the computer runtime the control plane recorded for it, which is an approximation of its
 * computer alone: snapshot storage and the shared stack costs are not in it. A read that fails is `error`, never zero:
 * an unreadable meter must not look like an organization that spent nothing. A day the computer never ran is a
 * measured zero.
 */
async function awsSpendFor(
	organization: Organization,
	request: DailyRollupRequest,
	rollupDate: string,
): Promise<[Decimal | null, string]> {
	if (organization.awsCrossAccountRole !== null && organization.awsCrossAccountRole !== "") {
		return customerAccountSpend(organization, request.accountSpend, rollupDate);
	}
	try {
		const spend = await request.hostedComputerSpend.dailyTotal({ tenantId: organization.tenantId, rollupDate });
		return [spend, CE_STATUS_OK];
	} catch (error) {
		console.warn(`computer_runtime_unreadable tenant_id=${organization.tenantId} reason=${String(error)}`);
		return [null, CE_STATUS_ERROR];
	}
}

async function customerAccountSpend(
	organization: Organization,
	accountSpend: AccountSpendReader | null,
	rollupDate: string,
): Promise<[Decimal | null, string]> {
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

type VendorSpend = { readonly total: Decimal; readonly unpricedCalls: number };

/**
 * The vendor dollars and unpriced calls of the ledger rows that fall in a window of days. A gateway row whose call a
 * session row already lists among its response ids is the same call and is skipped, so it is never counted twice; a row
 * with unpriced calls adds them to the count instead of vanishing from the sum.
 */
function sumVendorRows(rows: readonly VendorLedgerRow[], firstDay: string, lastDay: string): VendorSpend {
	const accountedCalls = new Set(rows.filter((row) => row.source !== GATEWAY_SOURCE).flatMap((row) => row.responseIds));
	let total = Decimal.zero();
	let unpricedCalls = 0;
	for (const row of rows) {
		const rowDay = dayWrittenIn(row.recordedAt);
		if (rowDay < firstDay || rowDay > lastDay || row.billedVia !== BILLED_VIA_VENDOR) continue;
		if (row.source === GATEWAY_SOURCE && row.callId !== null && accountedCalls.has(row.callId)) continue;
		unpricedCalls += row.unpricedCalls;
		if (row.costUsd !== null) total = total.add(row.costUsd);
	}
	return { total, unpricedCalls };
}

async function vendorDailyTotal(store: BudgetStore, tenantId: string, rollupDate: string): Promise<VendorSpend> {
	return sumVendorRows(await store.listVendorLedgerRowsForTenant(tenantId), rollupDate, rollupDate);
}

async function vendorMonthToDateTotal(store: BudgetStore, rollupDate: string): Promise<VendorSpend> {
	const monthStart = firstDayOfMonth(rollupDate);
	let total = Decimal.zero();
	let unpricedCalls = 0;
	for (const organization of await store.listEnabledOrganizations()) {
		const spend = sumVendorRows(await store.listVendorLedgerRowsForTenant(organization.tenantId), monthStart, rollupDate);
		total = total.add(spend.total);
		unpricedCalls += spend.unpricedCalls;
	}
	return { total, unpricedCalls };
}

async function maybePublishVendorThreshold(request: DailyRollupRequest): Promise<void> {
	const { store, alerts, environment, rollupDate, monthlyLimitUsd } = request;
	if (alerts === null || !monthlyLimitUsd.isPositive()) {
		return;
	}
	const { total: vendorMtd, unpricedCalls } = await vendorMonthToDateTotal(store, rollupDate);
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
		unpricedCalls,
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
