/**
 * Cross-account role validation for customer self-setup, and the ExternalId-guarded AssumeRole every customer
 * account call goes through. Chatticus never holds a standing credential for a customer account: it assumes the
 * organization's role with the organization's ExternalId, and refuses rather than falls back.
 * Ported from python/src/chatticus/cross_account_provisioning.py lines 1-364,
 * python/src/chatticus/cross_account_assume_role.py lines 1-75 and
 * python/src/chatticus/org_records.py lines 292-356.
 */

import type { Decimal } from "../budget/decimal.ts";
import { NotOrganizationOwnerError, OrganizationNotFoundError } from "../http/errors.ts";
import { OrganizationsKernelImpl, type Organization } from "../domain/organizations.ts";
import {
	OrganizationSpendCeilingInvalidError,
	OrganizationSpendCeilingRequiredError,
	requireValidMonthlyAwsSpendCeilingUsd,
} from "../domain/organization-spend.ts";
import type { MessagingStore } from "../store/messaging-store.ts";
import {
	AwsApiError,
	type AssumeRolePort,
	type AssumedRoleCredentials,
	type IamPolicyReaderPort,
	type SessionCredentials,
} from "./aws-ports.ts";
import { defaultAssumeRole, defaultIamPolicyReader } from "./aws-clients.ts";

export const ASSISTED_SETUP_FEE_CENTS = 10_000;

export const PROVISIONING_REQUIRED_PERMISSIONS: readonly string[] = [
	"cloudformation:CreateStack",
	"cloudformation:UpdateStack",
	"cloudformation:DeleteStack",
	"cloudformation:DescribeStacks",
	"ecs:CreateCluster",
	"ecs:RunTask",
	"ec2:CreateVpc",
	"ecr:GetAuthorizationToken",
	"logs:CreateLogGroup",
	"iam:PassRole",
	"ce:GetCostAndUsage",
];

/** Live cross-account role inspection failed before validation could finish. */
export class CrossAccountRoleInspectionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CrossAccountRoleInspectionError";
	}
}

/** An organization has no recorded cross-account role to assume. */
export class OrganizationCrossAccountRoleMissingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OrganizationCrossAccountRoleMissingError";
	}
}

/** Trust and permission view of one customer cross-account role. */
export interface CrossAccountRoleSnapshot {
	accountId: string;
	roleArn: string;
	trustedExternalId: string | null;
	grantedPermissions: ReadonlySet<string>;
}

/** Inspect one customer cross-account role before provisioning. */
export interface CrossAccountRoleInspector {
	/** Return trust and permission details for `roleArn`. */
	inspectRole(accountId: string, roleArn: string, options: { expectedExternalId: string }): Promise<CrossAccountRoleSnapshot>;
}

/** Outcome of one customer self-setup cross-account submission. */
export interface SelfSetupCrossAccountResult {
	accepted: boolean;
	organization: Organization;
	message: string | null;
}

function roleNameFromArn(roleArn: string): string {
	const segments = roleArn.split("/");
	return segments[segments.length - 1] ?? "";
}

function assumeRoleFailedMessage(expectedExternalId: string): string {
	return (
		`The cross-account role could not be assumed with ExternalId ${JSON.stringify(expectedExternalId)}. ` +
		"Re-run the Chatticus cross-account CloudFormation template with OrganizationId set to your Chatticus organization id."
	);
}

function policyReadFailedMessage(): string {
	return "The cross-account role could not be inspected. Re-run the published Chatticus cross-account template in your AWS account.";
}

/** Collect Allow actions from one IAM policy document. */
export function iamActionsFromPolicyDocument(document: unknown): ReadonlySet<string> {
	let parsed: unknown;
	if (typeof document === "string") {
		try {
			parsed = JSON.parse(document);
		} catch {
			return new Set();
		}
	} else if (typeof document === "object" && document !== null && !Array.isArray(document)) {
		parsed = document;
	} else {
		return new Set();
	}
	const rawStatements = (parsed as { Statement?: unknown }).Statement ?? [];
	const statements = Array.isArray(rawStatements) ? rawStatements : [rawStatements];
	const actions = new Set<string>();
	for (const statement of statements) {
		if (typeof statement !== "object" || statement === null || Array.isArray(statement)) {
			continue;
		}
		const { Effect: effect, Action: action } = statement as { Effect?: unknown; Action?: unknown };
		if (effect !== "Allow") {
			continue;
		}
		if (typeof action === "string") {
			actions.add(action);
		} else if (Array.isArray(action)) {
			for (const item of action) {
				if (typeof item === "string") {
					actions.add(item);
				}
			}
		}
	}
	return actions;
}

async function grantedPermissionsFromRolePolicies(roleArn: string, reader: IamPolicyReaderPort): Promise<ReadonlySet<string>> {
	const roleName = roleNameFromArn(roleArn);
	const granted = new Set<string>();
	const listed = await reader.listRolePolicies({ RoleName: roleName });
	for (const policyName of listed.PolicyNames ?? []) {
		if (typeof policyName !== "string") {
			continue;
		}
		const response = await reader.getRolePolicy({ RoleName: roleName, PolicyName: policyName });
		for (const action of iamActionsFromPolicyDocument(response.PolicyDocument ?? {})) {
			granted.add(action);
		}
	}
	return granted;
}

/** Live role inspector using STS AssumeRole and IAM inline policy reads. */
export class AwsCrossAccountRoleInspector implements CrossAccountRoleInspector {
	private readonly assumeRole: AssumeRolePort;
	private readonly iamPolicyReader: (credentials: SessionCredentials) => IamPolicyReaderPort;

	constructor(
		options: {
			assumeRole?: AssumeRolePort;
			iamPolicyReader?: (credentials: SessionCredentials) => IamPolicyReaderPort;
		} = {},
	) {
		this.assumeRole = options.assumeRole ?? defaultAssumeRole;
		this.iamPolicyReader = options.iamPolicyReader ?? defaultIamPolicyReader;
	}

	/** Assume the customer role and read its IAM policies for permissions. */
	async inspectRole(
		accountId: string,
		roleArn: string,
		options: { expectedExternalId: string },
	): Promise<CrossAccountRoleSnapshot> {
		let credentials: AssumedRoleCredentials;
		try {
			const response = await this.assumeRole({
				RoleArn: roleArn,
				RoleSessionName: `chatticus-inspect-${accountId}`,
				ExternalId: options.expectedExternalId,
			});
			credentials = response.Credentials;
		} catch (error) {
			if (error instanceof AwsApiError) {
				throw new CrossAccountRoleInspectionError(assumeRoleFailedMessage(options.expectedExternalId));
			}
			throw error;
		}
		const reader = this.iamPolicyReader({
			accessKeyId: String(credentials.AccessKeyId),
			secretAccessKey: String(credentials.SecretAccessKey),
			sessionToken: String(credentials.SessionToken),
		});
		let grantedPermissions: ReadonlySet<string>;
		try {
			grantedPermissions = await grantedPermissionsFromRolePolicies(roleArn, reader);
		} catch (error) {
			if (error instanceof AwsApiError) {
				throw new CrossAccountRoleInspectionError(policyReadFailedMessage());
			}
			throw error;
		}
		return { accountId, roleArn, trustedExternalId: options.expectedExternalId, grantedPermissions };
	}
}

/** Return the 12-digit account id embedded in `roleArn`, if present. */
export function accountIdFromRoleArn(roleArn: string): string | null {
	const prefix = "arn:aws:iam::";
	if (!roleArn.startsWith(prefix)) {
		return null;
	}
	const remainder = roleArn.slice(prefix.length);
	const separatorIndex = remainder.indexOf(":");
	if (separatorIndex === -1) {
		return null;
	}
	const accountId = remainder.slice(0, separatorIndex);
	if (accountId.length !== 12 || !/^[0-9]+$/.test(accountId)) {
		return null;
	}
	return accountId;
}

/** Validate one customer role submission and return an acceptance decision. */
export async function validateCrossAccountRoleForSelfSetup(
	organization: Organization,
	options: { accountId: string; crossAccountRole: string; roleInspector: CrossAccountRoleInspector },
): Promise<SelfSetupCrossAccountResult> {
	const { accountId, crossAccountRole, roleInspector } = options;
	const rejected = (message: string): SelfSetupCrossAccountResult => ({ accepted: false, organization, message });
	const roleAccountId = accountIdFromRoleArn(crossAccountRole);
	if (roleAccountId === null) {
		return rejected(
			"The role ARN is not a valid IAM role ARN. Copy the RoleArn output from the Chatticus cross-account CloudFormation stack.",
		);
	}
	if (roleAccountId !== accountId) {
		return rejected(
			`The role ARN belongs to account ${roleAccountId}, but ${accountId} was submitted. ` +
				"Use the AWS account id where you ran the Chatticus cross-account template.",
		);
	}

	let snapshot: CrossAccountRoleSnapshot;
	try {
		snapshot = await roleInspector.inspectRole(accountId, crossAccountRole, { expectedExternalId: organization.tenantId });
	} catch (error) {
		if (error instanceof CrossAccountRoleInspectionError) {
			return rejected(error.message);
		}
		throw error;
	}
	const expectedExternalId = organization.tenantId;
	if (snapshot.trustedExternalId !== expectedExternalId) {
		const trusted = snapshot.trustedExternalId === null ? "None" : JSON.stringify(snapshot.trustedExternalId);
		return rejected(
			`The role trusts ExternalId ${trusted}, but this organization requires ${JSON.stringify(expectedExternalId)}. ` +
				"Re-run the Chatticus cross-account CloudFormation template with OrganizationId set to your Chatticus organization id.",
		);
	}

	const missingPermission = PROVISIONING_REQUIRED_PERMISSIONS.find((permission) => !snapshot.grantedPermissions.has(permission));
	if (missingPermission !== undefined) {
		return rejected(
			`The role is missing ${missingPermission}, which cross-account provisioning requires. ` +
				"Re-run the published Chatticus cross-account template in your AWS account.",
		);
	}

	if (organization.status !== "pending") {
		return rejected(
			`Organization ${JSON.stringify(organization.tenantId)} has status ${JSON.stringify(organization.status)}; self-setup requires pending.`,
		);
	}

	return { accepted: true, organization, message: null };
}

/** Return one organization updated after accepted self-setup validation. */
export function organizationAfterAcceptedSelfSetup(
	organization: Organization,
	options: { accountId: string; crossAccountRole: string; monthlyAwsSpendCeilingUsd: Decimal },
): Organization {
	return {
		...organization,
		awsAccountId: options.accountId,
		awsCrossAccountRole: options.crossAccountRole,
		awsExternalId: organization.tenantId,
		awsSetupPath: "customer-owned",
		setupFeeCents: 0,
		assistedSetupSession: false,
		status: "enabled",
		monthlyAwsSpendCeilingUsd: options.monthlyAwsSpendCeilingUsd,
	};
}

/** Return one organization updated after an Anthus-assisted setup session. */
export function organizationAfterAssistedSetup(
	organization: Organization,
	options: { accountId: string; crossAccountRole: string; monthlyAwsSpendCeilingUsd: Decimal },
): Organization {
	return {
		...organization,
		awsAccountId: options.accountId,
		awsCrossAccountRole: options.crossAccountRole,
		awsExternalId: organization.tenantId,
		awsSetupPath: "anthus-managed",
		setupFeeCents: ASSISTED_SETUP_FEE_CENTS,
		assistedSetupSession: true,
		status: "enabled",
		monthlyAwsSpendCeilingUsd: options.monthlyAwsSpendCeilingUsd,
	};
}

/** Return the membership when the actor may submit self-setup; owner-only. */
export async function assertMaySubmitSelfSetupCrossAccountRole(
	tenantId: string,
	actorUserId: string,
	deps: { store: MessagingStore },
): Promise<void> {
	const organization = await deps.store.getOrganization(tenantId);
	if (organization === null) {
		throw new OrganizationNotFoundError(`Organization ${JSON.stringify(tenantId)} is unknown.`);
	}
	const membership = await deps.store.getMembership(tenantId, actorUserId);
	if (membership === null || membership.role !== "owner") {
		throw new NotOrganizationOwnerError(`User ${JSON.stringify(actorUserId)} is not an owner of ${JSON.stringify(tenantId)}.`);
	}
}

/** Validate and accept one customer self-setup cross-account submission. */
export async function submitSelfSetupCrossAccountRole(
	tenantId: string,
	submission: {
		actorUserId: string;
		accountId: string;
		crossAccountRole: string;
		roleInspector: CrossAccountRoleInspector;
		monthlyAwsSpendCeilingUsd: Decimal | null;
	},
	deps: { store: MessagingStore },
): Promise<SelfSetupCrossAccountResult> {
	await assertMaySubmitSelfSetupCrossAccountRole(tenantId, submission.actorUserId, deps);
	const organization = await deps.store.getOrganization(tenantId);
	if (organization === null) {
		throw new OrganizationNotFoundError(`Organization ${JSON.stringify(tenantId)} is unknown.`);
	}
	let ceiling: Decimal;
	try {
		ceiling = requireValidMonthlyAwsSpendCeilingUsd(submission.monthlyAwsSpendCeilingUsd);
	} catch (error) {
		if (error instanceof OrganizationSpendCeilingRequiredError || error instanceof OrganizationSpendCeilingInvalidError) {
			return { accepted: false, organization, message: error.message };
		}
		throw error;
	}
	const decision = await validateCrossAccountRoleForSelfSetup(organization, {
		accountId: submission.accountId,
		crossAccountRole: submission.crossAccountRole,
		roleInspector: submission.roleInspector,
	});
	if (!decision.accepted) {
		return decision;
	}
	const provisioned = organizationAfterAcceptedSelfSetup(organization, {
		accountId: submission.accountId,
		crossAccountRole: submission.crossAccountRole,
		monthlyAwsSpendCeilingUsd: ceiling,
	});
	await deps.store.putOrganization(provisioned);
	return { accepted: true, organization: provisioned, message: null };
}

/** Temporary credentials from one successful AssumeRole call. */
export interface CrossAccountRoleSession {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken: string;
	expiration: Date;
}

/** Result of one cross-account AssumeRole attempt. */
export interface CrossAccountAssumeRoleOutcome {
	externalId: string | null;
	session: CrossAccountRoleSession | null;
	refused: boolean;
}

/**
 * Assume one organization's cross-account role with its ExternalId.
 *
 * When `externalId` is omitted, the value recorded on the organization is used. A mismatched ExternalId is refused
 * before calling STS.
 */
export async function attemptCrossAccountAssumeRole(
	organization: Organization,
	options: { externalId?: string | null; assumeRole: AssumeRolePort },
): Promise<CrossAccountAssumeRoleOutcome> {
	if (organization.awsCrossAccountRole === null || organization.awsExternalId === null) {
		throw new OrganizationCrossAccountRoleMissingError(
			`Organization ${JSON.stringify(organization.tenantId)} has no cross-account role.`,
		);
	}
	const presentedExternalId = options.externalId ?? organization.awsExternalId;
	if (presentedExternalId !== organization.awsExternalId) {
		return { externalId: presentedExternalId, session: null, refused: true };
	}
	const response = await options.assumeRole({
		RoleArn: organization.awsCrossAccountRole,
		RoleSessionName: `chatticus-${organization.tenantId}`,
		ExternalId: presentedExternalId,
	});
	const credentials = response.Credentials;
	return {
		externalId: presentedExternalId,
		session: {
			accessKeyId: String(credentials.AccessKeyId),
			secretAccessKey: String(credentials.SecretAccessKey),
			sessionToken: String(credentials.SessionToken),
			expiration: credentials.Expiration,
		},
		refused: false,
	};
}

/** Assume one stored organization's cross-account role with its ExternalId. */
export async function assumeOrganizationCrossAccountRole(
	tenantId: string,
	options: { externalId?: string | null; assumeRole: AssumeRolePort },
	deps: { store: MessagingStore },
): Promise<CrossAccountAssumeRoleOutcome> {
	const organization = await new OrganizationsKernelImpl().getOrganization(tenantId, deps);
	return attemptCrossAccountAssumeRole(organization, options);
}
