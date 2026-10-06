import type { Context } from "hono";
import { submitSelfSetupCrossAccountRole, type CrossAccountRoleInspector } from "../../computer/provisioning.ts";
import { isRefusal, pathParameter, resolveUserPrincipal, type UserPrincipalDependencies } from "../user-principal.ts";
import { CeilingBodyRefusal, parseMonthlyAwsSpendCeilingUsd } from "./spend-ceiling.ts";

/** What the self-setup route needs: the principal seam and the live or in-memory role inspector. */
export interface SelfSetupRouteDependencies extends UserPrincipalDependencies {
	roleInspector: CrossAccountRoleInspector;
}

/** Response for an accepted POST /orgs/{tenant_id}/self-setup/cross-account-role. */
export interface SubmitSelfSetupCrossAccountRoleResponseBody {
	accepted: true;
	tenant_id: string;
	name: string;
	status: string;
	monthly_aws_spend_ceiling_usd: string;
}

/**
 * POST /orgs/{tenant_id}/self-setup/cross-account-role: the owner of a pending organization submits their AWS
 * account id and the RoleArn from the Chatticus cross-account template. The role is inspected, and on acceptance
 * the organization is enabled with its AWS home recorded. Waitlist-safe: a pending organization's owner may call
 * it; an operator bearer or a worker credential may not.
 * Ported from python/src/chatticus/http/app.py lines 439-465 and 923-966.
 */
export async function submitSelfSetupCrossAccountRoleHandler(
	c: Context,
	deps: SelfSetupRouteDependencies,
): Promise<Response> {
	const principal = await resolveUserPrincipal(c, deps, { requireEnabledMember: false });
	if (isRefusal(principal)) {
		return principal;
	}
	if (principal.userId === null) {
		return c.json({ detail: "user credential required" }, 403);
	}
	const requestBody = (await c.req.json().catch(() => null)) as {
		account_id?: unknown;
		cross_account_role?: unknown;
		monthly_aws_spend_ceiling_usd?: unknown;
	} | null;
	if (
		requestBody === null ||
		typeof requestBody.account_id !== "string" ||
		typeof requestBody.cross_account_role !== "string" ||
		typeof requestBody.monthly_aws_spend_ceiling_usd !== "string"
	) {
		return c.json({ detail: "account_id, cross_account_role and monthly_aws_spend_ceiling_usd are required" }, 422);
	}
	const accountId = requestBody.account_id.trim();
	const crossAccountRole = requestBody.cross_account_role.trim();
	if (accountId === "") {
		return c.json({ detail: "account_id is required" }, 400);
	}
	if (crossAccountRole === "") {
		return c.json({ detail: "cross_account_role is required" }, 400);
	}
	let ceiling;
	try {
		ceiling = parseMonthlyAwsSpendCeilingUsd(requestBody.monthly_aws_spend_ceiling_usd);
	} catch (error) {
		if (error instanceof CeilingBodyRefusal) {
			return c.json({ detail: error.message }, 400);
		}
		throw error;
	}
	const result = await submitSelfSetupCrossAccountRole(
		pathParameter(c, "tenant_id"),
		{
			actorUserId: principal.userId,
			accountId,
			crossAccountRole,
			roleInspector: deps.roleInspector,
			monthlyAwsSpendCeilingUsd: ceiling,
		},
		deps,
	);
	if (!result.accepted) {
		return c.json({ detail: result.message }, 422);
	}
	const organization = result.organization;
	const stored = organization.monthlyAwsSpendCeilingUsd;
	if (stored === null) {
		throw new Error("The ceiling was not stored.");
	}
	const body: SubmitSelfSetupCrossAccountRoleResponseBody = {
		accepted: true,
		tenant_id: organization.tenantId,
		name: organization.name,
		status: organization.status,
		monthly_aws_spend_ceiling_usd: stored.toString(),
	};
	return c.json(body, 200);
}
