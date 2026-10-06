import type { Context } from "hono";
import { Decimal } from "../../budget/decimal.ts";
import {
	requireValidMonthlyAwsSpendCeilingUsd,
	setMonthlyAwsSpendCeiling,
	OrganizationSpendCeilingInvalidError,
	OrganizationSpendCeilingRequiredError,
} from "../../domain/organization-spend.ts";
import { isRefusal, pathParameter, resolveUserPrincipal, type UserPrincipalDependencies } from "../user-principal.ts";

/** Response for PATCH /orgs/{tenant_id}/monthly-aws-spend-ceiling. */
export interface SetMonthlyAwsSpendCeilingResponseBody {
	tenant_id: string;
	monthly_aws_spend_ceiling_usd: string;
}

class CeilingBodyRefusal extends Error {}

/**
 * Parse one positive monthly AWS spend ceiling from an HTTP body field.
 * Ported from python/src/chatticus/http/app.py lines 470-495.
 */
function parseMonthlyAwsSpendCeilingUsd(raw: string): Decimal {
	const stripped = raw.trim();
	if (stripped === "") {
		throw new CeilingBodyRefusal("monthly_aws_spend_ceiling_usd is required");
	}
	let value: Decimal;
	try {
		value = Decimal.parse(stripped);
	} catch {
		throw new CeilingBodyRefusal("monthly_aws_spend_ceiling_usd must be a decimal number");
	}
	try {
		return requireValidMonthlyAwsSpendCeilingUsd(value);
	} catch (error) {
		if (error instanceof OrganizationSpendCeilingInvalidError || error instanceof OrganizationSpendCeilingRequiredError) {
			throw new CeilingBodyRefusal(error.message);
		}
		throw error;
	}
}

/**
 * PATCH /orgs/{tenant_id}/monthly-aws-spend-ceiling: an organization owner
 * sets the monthly AWS spend ceiling. Ported from python/src/chatticus/http/app.py lines 969-998.
 */
export async function setMonthlyAwsSpendCeilingHandler(c: Context, deps: UserPrincipalDependencies): Promise<Response> {
	const principal = await resolveUserPrincipal(c, deps);
	if (isRefusal(principal)) {
		return principal;
	}
	if (principal.userId === null) {
		return c.json({ detail: "user credential required" }, 403);
	}
	const requestBody = (await c.req.json().catch(() => null)) as { monthly_aws_spend_ceiling_usd?: unknown } | null;
	if (requestBody === null || typeof requestBody.monthly_aws_spend_ceiling_usd !== "string") {
		return c.json({ detail: "monthly_aws_spend_ceiling_usd is required" }, 422);
	}
	let ceiling: Decimal;
	try {
		ceiling = parseMonthlyAwsSpendCeilingUsd(requestBody.monthly_aws_spend_ceiling_usd);
	} catch (error) {
		if (error instanceof CeilingBodyRefusal) {
			return c.json({ detail: error.message }, 400);
		}
		throw error;
	}
	const organization = await setMonthlyAwsSpendCeiling(pathParameter(c, "tenant_id"), principal.userId, ceiling, deps);
	const stored = organization.monthlyAwsSpendCeilingUsd;
	if (stored === null) {
		throw new Error("The ceiling was not stored.");
	}
	const body: SetMonthlyAwsSpendCeilingResponseBody = {
		tenant_id: organization.tenantId,
		monthly_aws_spend_ceiling_usd: stored.toString(),
	};
	return c.json(body, 200);
}
