import assert from "node:assert/strict";
import { Decimal } from "../src/budget/decimal.ts";
import { PROVISIONING_REQUIRED_PERMISSIONS, type CrossAccountAssumeRoleOutcome, type SelfSetupCrossAccountResult } from "../src/computer/provisioning.ts";
import { OrganizationsKernelImpl, type Organization } from "../src/domain/organizations.ts";
import type { RecordedResponse } from "./api.ts";
import { CUSTOMER_ACCOUNT_ID, CUSTOMER_ROLE_ARN, RecordingAssumeRole } from "./fakes/fake-customer-aws.ts";
import type { ChatticusWorld } from "./world.ts";

const kernel = new OrganizationsKernelImpl();

export const MISMATCHED_EXTERNAL_ID = "wrong-organization-id";
export const MISSING_PERMISSION: string = PROVISIONING_REQUIRED_PERMISSIONS[0] as string;
export const DEFAULT_MONTHLY_AWS_SPEND_CEILING = "250.00";

/** What one self-setup, assume-role or provisioned-home scenario drives and observes. */
export interface CustomerSelfSetupScenario {
	ownerEmail: string | null;
	organization: Organization | null;
	otherOrganization: Organization | null;
	directResult: SelfSetupCrossAccountResult | null;
	response: RecordedResponse | null;
	assumeRole: RecordingAssumeRole;
	assumeOrganization: Organization | null;
	firstOrganization: Organization | null;
	secondOrganization: Organization | null;
	assumeOutcome: CrossAccountAssumeRoleOutcome | null;
	provisionedOrganization: Organization | null;
	pendingOrganization: Organization | null;
}

/** The scenario's self-setup state, created on first use. */
export function selfSetupScenario(world: ChatticusWorld): CustomerSelfSetupScenario {
	if (world.customerSelfSetup === null) {
		world.customerSelfSetup = {
			ownerEmail: null,
			organization: null,
			otherOrganization: null,
			directResult: null,
			response: null,
			assumeRole: new RecordingAssumeRole(),
			assumeOrganization: null,
			firstOrganization: null,
			secondOrganization: null,
			assumeOutcome: null,
			provisionedOrganization: null,
			pendingOrganization: null,
		};
	}
	return world.customerSelfSetup;
}

/** The pending organization under self-setup. */
export function selfSetupOrganization(world: ChatticusWorld): Organization {
	const organization = selfSetupScenario(world).organization;
	assert.ok(organization, "No pending self-setup organization is set.");
	return organization;
}

/** The organization as stored now. */
export async function storedOrganizationOf(world: ChatticusWorld, tenantId: string): Promise<Organization> {
	return kernel.getOrganization(tenantId, { store: world.messagingStore() });
}

/** A new pending organization owned by `ownerEmail`, created through the production kernel. */
export async function createPendingOrganization(world: ChatticusWorld, ownerEmail: string, name: string): Promise<Organization> {
	const deps = { store: world.messagingStore(), clock: world.clock, ids: world.ids };
	const owner = await kernel.signIn(ownerEmail, deps);
	const organization = await kernel.createOrganization(owner, name, deps);
	world.identitiesByEmail?.set(ownerEmail, owner);
	world.orgsByName?.set(name, organization);
	return organization;
}

/** Configure the customer's role as the inspector will report it for the standard account and role. */
export function configureCustomerRole(
	world: ChatticusWorld,
	options: { trustedExternalId: string; grantedPermissions?: ReadonlySet<string> },
): void {
	world.roleInspector.configure({
		accountId: CUSTOMER_ACCOUNT_ID,
		roleArn: CUSTOMER_ROLE_ARN,
		trustedExternalId: options.trustedExternalId,
		grantedPermissions: options.grantedPermissions ?? new Set(PROVISIONING_REQUIRED_PERMISSIONS),
	});
}

/** Every permission self-setup requires except the first one the role is made to lack. */
export function permissionsWithoutTheMissingOne(): ReadonlySet<string> {
	return new Set(PROVISIONING_REQUIRED_PERMISSIONS.filter((permission) => permission !== MISSING_PERMISSION));
}

/** The body every standard self-setup submission posts. */
export function selfSetupPayload(): Record<string, string> {
	return {
		account_id: CUSTOMER_ACCOUNT_ID,
		cross_account_role: CUSTOMER_ROLE_ARN,
		monthly_aws_spend_ceiling_usd: DEFAULT_MONTHLY_AWS_SPEND_CEILING,
	};
}

/** The default monthly ceiling as a decimal. */
export function defaultMonthlyCeiling(): Decimal {
	return Decimal.parse(DEFAULT_MONTHLY_AWS_SPEND_CEILING);
}
