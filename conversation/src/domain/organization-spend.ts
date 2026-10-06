import { addDays, firstDayOfMonth, utcDayOf } from "../budget/calendar.ts";
import type { BudgetStore } from "../budget/budget-store.ts";
import { Decimal } from "../budget/decimal.ts";
import { CE_STATUS_ERROR, CE_STATUS_OK, CE_STATUS_PENDING } from "../budget/models.ts";
import {
	NotOrganizationOwnerError,
	OrganizationNotFoundError,
	OrganizationSpendCeilingExceededError,
	OrganizationSpendCeilingInvalidError,
	OrganizationSpendCeilingRequiredError,
} from "../http/errors.ts";
import type { MessagingStore } from "../store/messaging-store.ts";
import type { Organization } from "./organizations.ts";

export {
	OrganizationSpendCeilingExceededError,
	OrganizationSpendCeilingInvalidError,
	OrganizationSpendCeilingRequiredError,
};

/** The rollup rows month-to-date spend is summed from, written by the TypeScript budget rollup. */
export type BudgetRollupReader = Pick<BudgetStore, "getBudgetRollupRow">;

/** Rollup statuses that make the month-to-date meter unknown. */
export const MTD_UNKNOWN_CE_STATUSES: ReadonlySet<string> = new Set([CE_STATUS_PENDING, CE_STATUS_ERROR]);

export const SPEND_CEILING_EXCEEDED_REASON = "monthly AWS spend ceiling exceeded";
export const SPEND_CEILING_METER_UNAVAILABLE_REASON = "monthly AWS spend is unavailable until Cost Explorer catches up";

/** Month-to-date combined spend and whether the meter is incomplete. */
export interface OrganizationSpendMeter {
	monthToDateUsd: Decimal;
	meterUnknown: boolean;
}

/** Whether new computer work is refused for spend reasons, and why. */
export interface ComputerWorkPause {
	paused: boolean;
	reason: string | null;
}

/** What the pause check reads: organizations, rollup rows, the budget environment and the time. */
export interface SpendPauseDependencies {
	store: MessagingStore;
	rollups: BudgetRollupReader;
	environment: string;
	clock: { now(): Date };
}

/**
 * Sum ok rollup rows from month start through `asOf`.
 *
 * Days with no rollup row count as zero. Any day with a pending or error
 * ce_status marks the meter unknown for fail-closed enforcement.
 * Ported from python/src/chatticus/organization_spend.py lines 28-60.
 */
export async function monthToDateCombinedSpendUsd(
	rollups: BudgetRollupReader,
	tenantId: string,
	environment: string,
	asOf: string,
): Promise<OrganizationSpendMeter> {
	let total = Decimal.zero();
	let meterUnknown = false;
	let current = firstDayOfMonth(asOf);
	while (current <= asOf) {
		const row = await rollups.getBudgetRollupRow(tenantId, environment, current);
		if (row !== null) {
			if (MTD_UNKNOWN_CE_STATUSES.has(row.ceStatus)) {
				meterUnknown = true;
			} else if (row.ceStatus === CE_STATUS_OK) {
				if (row.combinedReportUsd === null) {
					meterUnknown = true;
				} else {
					total = total.add(row.combinedReportUsd);
				}
			} else {
				meterUnknown = true;
			}
		}
		current = addDays(current, 1);
	}
	return { monthToDateUsd: total, meterUnknown };
}

/**
 * Whether new computer work should be refused for spend reasons.
 * Ported from python/src/chatticus/organization_spend.py lines 64-84.
 */
export async function organizationComputerWorkPaused(
	organization: Organization,
	rollups: BudgetRollupReader,
	environment: string,
	asOf: string,
): Promise<ComputerWorkPause> {
	const ceiling = organization.monthlyAwsSpendCeilingUsd;
	if (ceiling === null) {
		return { paused: false, reason: null };
	}
	const meter = await monthToDateCombinedSpendUsd(rollups, organization.tenantId, environment, asOf);
	if (meter.meterUnknown) {
		return { paused: true, reason: SPEND_CEILING_METER_UNAVAILABLE_REASON };
	}
	if (meter.monthToDateUsd.compare(ceiling) >= 0) {
		return { paused: true, reason: SPEND_CEILING_EXCEEDED_REASON };
	}
	return { paused: false, reason: null };
}

/**
 * Whether new computer work is paused for one organization as of today, or
 * the given day. Ported from ControlPlane.organization_computer_work_paused_for.
 */
export async function organizationComputerWorkPausedFor(
	organization: Organization,
	deps: SpendPauseDependencies,
	asOf: string = utcDayOf(deps.clock.now()),
): Promise<ComputerWorkPause> {
	return organizationComputerWorkPaused(organization, deps.rollups, deps.environment, asOf);
}

/**
 * Why new computer work is blocked by spend, or null. An unknown organization
 * is not paused. Ported from ControlPlane.computer_work_pause_reason.
 */
export async function computerWorkPauseReason(tenantId: string, deps: SpendPauseDependencies): Promise<string | null> {
	const organization = await deps.store.getOrganization(tenantId);
	if (organization === null) {
		return null;
	}
	if (organization.monthlyAwsSpendCeilingUsd === null) {
		return null;
	}
	const pause = await organizationComputerWorkPausedFor(organization, deps);
	if (!pause.paused) {
		return null;
	}
	return pause.reason ?? SPEND_CEILING_EXCEEDED_REASON;
}

/**
 * Throw when month-to-date spend blocks new computer work. The computer tool
 * and host-start paths call this before they do anything else.
 * Ported from ControlPlane._refuse_if_computer_work_paused.
 */
export async function refuseIfComputerWorkPaused(tenantId: string, deps: SpendPauseDependencies): Promise<void> {
	const reason = await computerWorkPauseReason(tenantId, deps);
	if (reason !== null) {
		throw new OrganizationSpendCeilingExceededError(reason);
	}
}

/**
 * Return a positive monthly AWS spend ceiling or throw.
 * Ported from python/src/chatticus/org_records.py lines 48-60.
 */
export function requireValidMonthlyAwsSpendCeilingUsd(monthlyAwsSpendCeilingUsd: Decimal | null): Decimal {
	if (monthlyAwsSpendCeilingUsd === null) {
		throw new OrganizationSpendCeilingRequiredError("monthly_aws_spend_ceiling_usd is required at provisioning.");
	}
	if (!monthlyAwsSpendCeilingUsd.isPositive()) {
		throw new OrganizationSpendCeilingInvalidError("monthly_aws_spend_ceiling_usd must be a positive USD amount.");
	}
	return monthlyAwsSpendCeilingUsd;
}

/**
 * Set one organization's monthly AWS spend ceiling; owner-only.
 * Ported from python/src/chatticus/org_records.py lines 358-378.
 */
export async function setMonthlyAwsSpendCeiling(
	tenantId: string,
	actorUserId: string,
	monthlyAwsSpendCeilingUsd: Decimal,
	deps: { store: MessagingStore },
): Promise<Organization> {
	const organization = await deps.store.getOrganization(tenantId);
	if (organization === null) {
		throw new OrganizationNotFoundError(`Organization ${JSON.stringify(tenantId)} is unknown.`);
	}
	const actor = await deps.store.getMembership(tenantId, actorUserId);
	if (actor === null || actor.role !== "owner") {
		throw new NotOrganizationOwnerError(
			`User ${JSON.stringify(actorUserId)} is not an owner of ${JSON.stringify(tenantId)}.`,
		);
	}
	const ceiling = requireValidMonthlyAwsSpendCeilingUsd(monthlyAwsSpendCeilingUsd);
	const updated: Organization = { ...organization, monthlyAwsSpendCeilingUsd: ceiling };
	await deps.store.putOrganization(updated);
	return updated;
}
