import type { BudgetStore } from "./budget-store.ts";
import { pythonIsoUtc } from "./calendar.ts";
import { Decimal } from "./decimal.ts";
import {
	ACCOUNT_TENANT_ID,
	AWS_BUDGET_ALERT_SOURCE,
	CE_STATUS_OK,
	ROLLUP_ALERT_SOURCE,
} from "./models.ts";

type JsonObject = Record<string, unknown>;

function parseSnsPayload(message: string): JsonObject | null {
	let payload: unknown;
	try {
		payload = JSON.parse(message);
	} catch {
		return null;
	}
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		return null;
	}
	return payload as JsonObject;
}

function budgetNameFrom(payload: JsonObject): string | null {
	for (const key of ["BudgetName", "budgetName"]) {
		const value = payload[key];
		if (typeof value === "string" && value !== "") {
			return value;
		}
	}
	return null;
}

function sortedKeysJson(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortedKeysJson);
	}
	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value as JsonObject).sort(([left], [right]) => (left < right ? -1 : 1));
		return Object.fromEntries(entries.map(([key, inner]) => [key, sortedKeysJson(inner)]));
	}
	return value;
}

export interface RecordBudgetAlertRequest {
	readonly store: BudgetStore;
	readonly environment: string;
	readonly rollupDate: string;
	readonly snsMessage: string;
	readonly now: Date;
}

/** Parse one SNS payload and record AWS Budgets alerts only. */
export async function recordBudgetAlertFromSns(request: RecordBudgetAlertRequest): Promise<boolean> {
	const { store, environment, rollupDate, now } = request;
	const payload = parseSnsPayload(request.snsMessage);
	if (payload === null || payload.source === ROLLUP_ALERT_SOURCE) {
		return false;
	}
	const budgetName = budgetNameFrom(payload);
	if (budgetName === null) {
		return false;
	}
	const firedAt = pythonIsoUtc(now);
	const existing = await store.getAccountBudgetRollupRow(environment, rollupDate);
	await store.putAccountBudgetRollupRow({
		tenantId: ACCOUNT_TENANT_ID,
		environment,
		rollupDate,
		awsCostUsd: existing?.awsCostUsd ?? null,
		vendorCostUsd: existing?.vendorCostUsd ?? Decimal.zero(),
		combinedReportUsd: existing?.combinedReportUsd ?? null,
		ceStatus: existing?.ceStatus ?? CE_STATUS_OK,
		alertEvents: [
			...(existing?.alertEvents ?? []),
			{ source: AWS_BUDGET_ALERT_SOURCE, firedAt, detail: JSON.stringify(sortedKeysJson(payload)) },
		],
		updatedAt: firedAt,
	});
	console.log(`aws_budget_alert_recorded budget_name=${budgetName} environment=${environment} rollup_date=${rollupDate}`);
	return true;
}
