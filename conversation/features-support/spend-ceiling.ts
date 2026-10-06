import assert from "node:assert/strict";
import { utcDayOf } from "../src/budget/calendar.ts";
import { Decimal } from "../src/budget/decimal.ts";
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

/** Run the real daily rollup for today so the organization's rows reflect what the fake Cost Explorer reports. */
export async function rollUpToday(world: ChatticusWorld): Promise<void> {
	await runDailyRollup({
		store: world.store,
		costExplorer: world.costExplorer,
		accountSpend: null,
		alerts: null,
		environment: world.budgetEnvironment,
		rollupDate: utcDayOf(world.clock.now()),
		monthlyLimitUsd: world.monthlyLimitUsd,
		now: world.clock.now(),
	});
}

/** Cost Explorer reports `amountUsd` for the organization today and the rollup records it. */
export async function spendToday(world: ChatticusWorld, amountUsd: string): Promise<void> {
	world.costExplorer.setDailyCost(
		world.budgetEnvironment,
		spendScenario(world).tenantId,
		utcDayOf(world.clock.now()),
		Decimal.parse(amountUsd),
	);
	await rollUpToday(world);
}
