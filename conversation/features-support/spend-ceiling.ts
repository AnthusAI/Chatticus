import assert from "node:assert/strict";
import { utcDayOf } from "../src/budget/calendar.ts";
import { Decimal } from "../src/budget/decimal.ts";
import { RecordedRuntimeComputerSpendReader } from "../src/budget/computer-runtime.ts";
import { CE_STATUS_OK } from "../src/budget/models.ts";
import { runDailyRollup } from "../src/budget/runner.ts";
import { setMonthlyAwsSpendCeiling } from "../src/domain/organization-spend.ts";
import { OrganizationsKernelImpl, type Organization } from "../src/domain/organizations.ts";
import type { RecordedResponse } from "./api.ts";
import { wireFrontDoor } from "./front-door.ts";
import type { ChatticusWorld } from "./world.ts";

const kernel = new OrganizationsKernelImpl();

export const OWNER_EMAIL = "owner@example.com";
export const MEMBER_EMAIL = "member@example.com";
export const ORGANIZATION_NAME = "Acme Labs";
export const DEFAULT_CEILING_USD = "250.00";
export const ABOVE_CEILING_MONTH_TO_DATE_USD = "300.00";

/** The scenario's organization, its people and the last responses its steps read. */
export interface SpendCeilingScenarioState {
	tenantId: string;
	ownerUserId: string;
	memberUserId: string | null;
	channelId: string | null;
	ceilingResponse: RecordedResponse | null;
	channelsResponse: RecordedResponse | null;
}

/** The scenario's spend-ceiling state, or a failure when no organization was provisioned. */
export function spendScenario(world: ChatticusWorld): SpendCeilingScenarioState {
	assert.ok(world.spendCeilingScenario, "No organization with a spend ceiling is set for this scenario.");
	return world.spendCeilingScenario;
}

/** The organization as stored now, read through the organizations kernel. */
export async function storedOrganization(world: ChatticusWorld): Promise<Organization> {
	return kernel.getOrganization(spendScenario(world).tenantId, { store: world.messagingStore() });
}

/**
 * An enabled organization whose owner has set the default monthly ceiling, served by the production HTTP
 * application with the budget environment of the scenario.
 */
export async function provisionEnabledOrganizationWithCeiling(world: ChatticusWorld): Promise<void> {
	await wireFrontDoor(world, { signupMode: "invitation_only", cognitoVerifier: true, environment: world.budgetEnvironment });
	const store = world.messagingStore();
	const deps = { store, clock: world.clock, ids: world.ids };
	const owner = await kernel.signIn(OWNER_EMAIL, deps);
	const created = await kernel.createOrganization(owner, ORGANIZATION_NAME, deps);
	const enabled = await kernel.enableOrganization(created.tenantId, { store });
	await setMonthlyAwsSpendCeiling(enabled.tenantId, owner.userId, Decimal.parse(DEFAULT_CEILING_USD), { store });
	world.currentIdentity = owner;
	world.orgsByName?.set(ORGANIZATION_NAME, enabled);
	world.spendCeilingScenario = {
		tenantId: enabled.tenantId,
		ownerUserId: owner.userId,
		memberUserId: null,
		channelId: null,
		ceilingResponse: null,
		channelsResponse: null,
	};
}

/** Run the real daily rollup for one day, pricing the computer runtime the table holds. */
export async function rollUpDay(world: ChatticusWorld, rollupDate: string): Promise<void> {
	await runDailyRollup({
		store: world.store,
		hostedComputerSpend: new RecordedRuntimeComputerSpendReader(world.store),
		accountSpend: null,
		alerts: null,
		reconciler: null,
		environment: world.budgetEnvironment,
		rollupDate,
		monthlyLimitUsd: world.monthlyLimitUsd,
		now: world.clock.now(),
	});
}

/** Write the rollup row the organization has for today, as the daily rollup would after reading the given figure. */
export async function recordMeterToday(
	world: ChatticusWorld,
	meter: { awsCostUsd: string | null; ceStatus: string },
	tenantId: string = spendScenario(world).tenantId,
): Promise<void> {
	const awsCostUsd = meter.awsCostUsd === null ? null : Decimal.parse(meter.awsCostUsd);
	await world.store.putBudgetRollupRow({
		tenantId,
		environment: world.budgetEnvironment,
		rollupDate: utcDayOf(world.clock.now()),
		awsCostUsd,
		vendorCostUsd: Decimal.zero(),
		unpricedCalls: 0,
		combinedReportUsd: awsCostUsd,
		ceStatus: meter.ceStatus,
		alertEvents: [],
		updatedAt: world.clock.now().toISOString(),
	});
}

/** The organization's meter reads `amountUsd` for today. */
export async function spendToday(world: ChatticusWorld, amountUsd: string, tenantId?: string): Promise<void> {
	await recordMeterToday(world, { awsCostUsd: amountUsd, ceStatus: CE_STATUS_OK }, tenantId);
}
