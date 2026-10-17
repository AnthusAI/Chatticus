import { DEFAULT_MONTHLY_AWS_SPEND_CEILING_USD, type Organization, type OrganizationStatus } from "../domain/organizations.ts";
import type { MessagingStore } from "../store/messaging-store.ts";

/** What the organization spend ceiling migration reads and writes. */
export type OrganizationSpendCeilingMigrationDependencies = {
	readonly store: MessagingStore;
};

/** Options of one pass. */
export type OrganizationSpendCeilingMigrationOptions = {
	/** Write for real; without it the pass only reports. */
	readonly execute: boolean;
	/** Limit the pass to one organization. */
	readonly tenantId?: string;
};

/** What happened, or would happen, to one organization. */
export type OrganizationSpendCeilingMigration = {
	readonly tenantId: string;
	readonly name: string;
	/** `set_ceiling`: the organization now has the default ceiling. `would_set_ceiling`: the same, in a dry run. */
	readonly outcome: "set_ceiling" | "would_set_ceiling";
};

const EVERY_ORGANIZATION_STATUS: readonly OrganizationStatus[] = ["pending", "enabled", "suspended"];

/**
 * Give every organization that has no monthly AWS spend ceiling the default ceiling new organizations start with. This
 * is the rule organization creation applies; the pass applies it once to organizations created before the rule existed.
 * A ceiling an owner already set is never changed, and running the pass twice changes nothing the second time.
 *
 * @param deps The organization records store.
 * @param options Whether to write, and an optional organization.
 * @returns One entry per organization that was, or would be, given the default ceiling.
 */
export async function giveOrganizationsWithoutSpendCeilingTheDefaultCeiling(
	deps: OrganizationSpendCeilingMigrationDependencies,
	options: OrganizationSpendCeilingMigrationOptions,
): Promise<OrganizationSpendCeilingMigration[]> {
	const candidates = await organizationsWithoutSpendCeiling(deps.store, options.tenantId);
	const migrations: OrganizationSpendCeilingMigration[] = [];
	for (const organization of candidates) {
		if (options.execute) {
			await deps.store.putOrganization({ ...organization, monthlyAwsSpendCeilingUsd: DEFAULT_MONTHLY_AWS_SPEND_CEILING_USD });
		}
		migrations.push({
			tenantId: organization.tenantId,
			name: organization.name,
			outcome: options.execute ? "set_ceiling" : "would_set_ceiling",
		});
	}
	return migrations;
}

async function organizationsWithoutSpendCeiling(store: MessagingStore, tenantId: string | undefined): Promise<Organization[]> {
	const organizations =
		tenantId === undefined
			? (await Promise.all(EVERY_ORGANIZATION_STATUS.map((status) => store.listOrganizationsByStatus(status)))).flat()
			: [await store.getOrganization(tenantId)].filter((organization): organization is Organization => organization !== null);
	return organizations.filter((organization) => organization.monthlyAwsSpendCeilingUsd === null);
}
