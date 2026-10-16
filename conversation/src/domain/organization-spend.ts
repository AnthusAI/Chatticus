import { addDays, firstDayOfMonth, utcDayOf } from "../budget/calendar.ts";
import type { BudgetStore } from "../budget/budget-store.ts";
import { MOST_A_HOSTED_COMPUTER_COSTS_IN_ONE_DAY_USD } from "../budget/computer-runtime.ts";
import { Decimal } from "../budget/decimal.ts";
import { CE_STATUS_OK, organizationRunsInItsOwnAwsAccount } from "../budget/models.ts";
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

export const SPEND_CEILING_EXCEEDED_REASON = "monthly AWS spend ceiling exceeded";
export const SPEND_CEILING_METER_UNAVAILABLE_REASON = "monthly AWS spend cannot be read right now";

/**
 * Month-to-date combined spend as the meter reads it. `monthToDateUsd` is what was measured. For an organization hosted in
 * the deployment account, days that could not be read are counted separately at the most they could have cost, in
 * `mostUnreadDaysCouldCostUsd`. For an organization in its own AWS account no such bound exists, so a day that could not
 * be read makes `meterUnknown` true.
 */
export interface OrganizationSpendMeter {
	monthToDateUsd: Decimal;
	mostUnreadDaysCouldCostUsd: Decimal;
	meterUnknown: boolean;
}

/** What the meter needs to know about an organization: who it is and where its AWS spend is. */
export type MeteredOrganization = Pick<Organization, "tenantId" | "awsCrossAccountRole">;

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
 * Sum the rollup rows from month start through `asOf`.
 *
 * Days with no rollup row count as zero. A day whose row was not read (pending, error, or an ok row without a figure)
 * counts, for an organization hosted in the deployment account, as its model spend plus the most its computer can cost
 * in a day; for an organization in its own AWS account it marks the meter unknown for fail-closed enforcement.
 */
export async function monthToDateCombinedSpendUsd(
	rollups: BudgetRollupReader,
	organization: MeteredOrganization,
	environment: string,
	asOf: string,
): Promise<OrganizationSpendMeter> {
	const unreadDaysAreBounded = !organizationRunsInItsOwnAwsAccount(organization);
	let monthToDateUsd = Decimal.zero();
	let mostUnreadDaysCouldCostUsd = Decimal.zero();
	let meterUnknown = false;
	let current = firstDayOfMonth(asOf);
	while (current <= asOf) {
		const row = await rollups.getBudgetRollupRow(organization.tenantId, environment, current);
		if (row !== null) {
			if (row.ceStatus === CE_STATUS_OK && row.combinedReportUsd !== null) {
				monthToDateUsd = monthToDateUsd.add(row.combinedReportUsd);
			} else if (unreadDaysAreBounded) {
				mostUnreadDaysCouldCostUsd = mostUnreadDaysCouldCostUsd
					.add(row.vendorCostUsd)
					.add(MOST_A_HOSTED_COMPUTER_COSTS_IN_ONE_DAY_USD);
			} else {
				meterUnknown = true;
			}
		}
		current = addDays(current, 1);
	}
	return { monthToDateUsd, mostUnreadDaysCouldCostUsd, meterUnknown };
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
	const meter = await monthToDateCombinedSpendUsd(rollups, organization, environment, asOf);
	if (meter.meterUnknown) {
		return { paused: true, reason: SPEND_CEILING_METER_UNAVAILABLE_REASON };
	}
	if (meter.monthToDateUsd.compare(ceiling) >= 0) {
		return { paused: true, reason: SPEND_CEILING_EXCEEDED_REASON };
	}
	if (meter.monthToDateUsd.add(meter.mostUnreadDaysCouldCostUsd).compare(ceiling) >= 0) {
		return { paused: true, reason: SPEND_CEILING_METER_UNAVAILABLE_REASON };
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
