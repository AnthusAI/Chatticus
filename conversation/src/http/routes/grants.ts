import type { Context } from "hono";
import { pythonRepr } from "../../domain/bots.ts";
import { grantFromPayload } from "../../policy/capability-policy.ts";
import { replaceTurnCapabilityGrant, type TurnGrantDependencies } from "../../policy/turn-grant.ts";
import { TurnAccessDeniedError } from "../errors.ts";
import { isRefusal, pathParameter, resolveUserPrincipal, type UserPrincipalDependencies } from "../user-principal.ts";

/** Everything the turn grant route depends on. */
export interface GrantRouteDependencies extends UserPrincipalDependencies {
	turns: TurnGrantDependencies["turns"];
	policyStore: TurnGrantDependencies["policyStore"];
}

const GRANT_LIST_FIELDS = ["tools", "origins", "recipients", "file_scopes", "egress_classes", "ingest_classes"] as const;

function invalidFieldOf(body: unknown): string | null {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return "the body must be an object";
	}
	for (const field of GRANT_LIST_FIELDS) {
		const value = (body as Record<string, unknown>)[field];
		if (value !== undefined && (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))) {
			return `${field} must be a list of strings`;
		}
	}
	return null;
}

/**
 * PUT /orgs/{tenant_id}/turns/{turn_id}/grant: an enabled member replaces the closed grant of an active turn. The grant
 * is exactly the body, never a union with the grant it replaces; an empty tool list is a full replacement. 403 for a
 * grant beyond the member's standing and for a turn the tenant does not own.
 */
export async function putTurnGrantHandler(c: Context, deps: GrantRouteDependencies): Promise<Response> {
	const principal = await resolveUserPrincipal(c, deps);
	if (isRefusal(principal)) {
		return principal;
	}
	if (principal.userId === null) {
		return c.json({ detail: "user credential required" }, 403);
	}
	const tenantId = pathParameter(c, "tenant_id");
	const turnId = pathParameter(c, "turn_id");
	const body = await c.req.json().catch(() => null);
	const invalid = invalidFieldOf(body);
	if (invalid !== null) {
		return c.json({ detail: invalid }, 422);
	}
	const turn = await deps.turns.store.getTurn(tenantId, turnId);
	if (turn === null) {
		throw new TurnAccessDeniedError(`Tenant ${pythonRepr(tenantId)} cannot grant turn ${pythonRepr(turnId)}.`);
	}
	const grant = grantFromPayload(body as Record<string, unknown>);
	await replaceTurnCapabilityGrant(deps, tenantId, turnId, grant, principal.userId);
	return c.json({ turn_id: turnId, tools: [...grant.tools].sort() }, 200);
}
