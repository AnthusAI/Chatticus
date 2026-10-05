import type { Decimal } from "./decimal.ts";

export const ACCOUNT_TENANT_ID = "__account__";

export const BILLED_VIA_VENDOR = "vendor";
export const BILLED_VIA_AWS = "aws";

export const ORGANIZATION_STATUS_ENABLED = "enabled";

export const CE_STATUS_OK = "ok";
export const CE_STATUS_PENDING = "pending";
export const CE_STATUS_ERROR = "error";

export const ROLLUP_ALERT_SOURCE = "chatticus.daily_rollup";
export const AWS_BUDGET_ALERT_SOURCE = "aws_budget";
export const DEFAULT_THRESHOLD_BANDS: readonly number[] = [50, 80, 100];

export interface BudgetAlertEvent {
	readonly source: string;
	readonly firedAt: string;
	readonly detail: string;
}

/** One org-environment-day or account-day rollup row. Days are `YYYY-MM-DD`. */
export interface BudgetRollupRow {
	readonly tenantId: string;
	readonly environment: string;
	readonly rollupDate: string;
	readonly awsCostUsd: Decimal | null;
	readonly vendorCostUsd: Decimal;
	readonly combinedReportUsd: Decimal | null;
	readonly ceStatus: string;
	readonly alertEvents: readonly BudgetAlertEvent[];
	readonly updatedAt: string;
}

export interface BudgetThresholdState {
	readonly environment: string;
	readonly lastNotifiedBand: number;
	readonly updatedAt: string;
}

/** The slice of the Python-owned organization item the budget jobs read. */
export interface Organization {
	readonly tenantId: string;
	readonly awsAccountId: string | null;
	readonly awsCrossAccountRole: string | null;
	readonly awsExternalId: string | null;
}

/** The slice of the Python-owned vendor ledger item the rollup reads. */
export interface VendorLedgerRow {
	readonly tenantId: string;
	readonly turnId: string;
	readonly billedVia: string;
	readonly costUsd: Decimal | null;
	readonly recordedAt: string;
}
