import { hasUnchosenAwsHome, withDeploymentAccountHome, type Organization } from "../domain/organizations.ts";
import type { MessagingStore } from "../store/messaging-store.ts";

/** What the organization AWS home migration reads and writes. */
export type OrganizationAwsHomeMigrationDependencies = {
	readonly store: MessagingStore;
};

/** Options of one pass. */
export type OrganizationAwsHomeMigrationOptions = {
	/** The account every selected organization is homed in; the deployment account of the environment. */
	readonly deploymentAwsAccountId: string;
	/** Write for real; without it the pass only reports. */
	readonly execute: boolean;
	/** Limit the pass to one organization. */
	readonly tenantId?: string;
};

/** What happened, or would happen, to one organization. */
export type OrganizationAwsHomeMigration = {
	readonly tenantId: string;
	readonly name: string;
	/** `homed`: the organization now has the deployment account as its home. `would_home`: the same, in a dry run. */
	readonly outcome: "homed" | "would_home";
};

const DEPLOYMENT_AWS_ACCOUNT_ID_PATTERN = /^\d{12}$/;

/**
 * Give every enabled organization that has no AWS home and no chosen setup path the deployment account as its home, as
 * Anthus-managed. This is the rule the organization lifecycle applies when an organization is enabled or reinstated;
 * the pass applies it once to organizations enabled before the rule existed. Pending organizations are left for the
 * enable rule, suspended ones for the reinstate rule, and an organization that chose a setup path is never touched.
 * Running the pass twice changes nothing the second time.
 *
 * @param deps The organization records store.
 * @param options The deployment account, whether to write, and an optional organization.
 * @returns One entry per organization that was, or would be, homed.
 */
export async function homeEnabledOrganizationsWithoutAwsHome(
	deps: OrganizationAwsHomeMigrationDependencies,
	options: OrganizationAwsHomeMigrationOptions,
): Promise<OrganizationAwsHomeMigration[]> {
	if (!DEPLOYMENT_AWS_ACCOUNT_ID_PATTERN.test(options.deploymentAwsAccountId)) {
		throw new Error("The deployment AWS account id must be a twelve-digit AWS account id.");
	}
	const candidates = await candidateOrganizations(deps.store, options.tenantId);
	const migrations: OrganizationAwsHomeMigration[] = [];
	for (const organization of candidates) {
		if (options.execute) {
			await deps.store.putOrganization(withDeploymentAccountHome(organization, options.deploymentAwsAccountId));
		}
		migrations.push({
			tenantId: organization.tenantId,
			name: organization.name,
			outcome: options.execute ? "homed" : "would_home",
		});
	}
	return migrations;
}

async function candidateOrganizations(store: MessagingStore, tenantId: string | undefined): Promise<Organization[]> {
	const enabled =
		tenantId === undefined
			? await store.listOrganizationsByStatus("enabled")
			: [await store.getOrganization(tenantId)].filter((organization): organization is Organization => organization !== null);
	return enabled.filter((organization) => organization.status === "enabled" && hasUnchosenAwsHome(organization));
}
