import type { Context } from "hono";
import type { IdTokenVerifier } from "../auth/cognito.ts";
import { MembershipCache } from "../auth/membership-cache.ts";
import type { CachedMembership, Principal } from "../auth/principal.ts";
import { resolvePrincipal } from "../auth/principal.ts";
import { StorePrincipalDirectory } from "../auth/store-principal-directory.ts";
import type { MessagingStore } from "../store/messaging-store.ts";
import type { Clock } from "./app.ts";

/** What an organization user route needs to resolve its caller. */
export interface UserPrincipalDependencies {
	store: MessagingStore;
	verifier: IdTokenVerifier | null;
	membershipCache: MembershipCache<CachedMembership>;
}

/** Per-application membership cache for organization user routes. */
export function createUserMembershipCache(clock: Clock): MembershipCache<CachedMembership> {
	return new MembershipCache<CachedMembership>({ nowMilliseconds: () => clock.now().getTime() });
}

/**
 * Resolve the enabled organization member calling an /orgs/{tenant_id}/... user route, or answer the refusal.
 *
 * @returns The principal, or the response to return when the caller is refused or the verifier is not configured.
 */
export async function resolveUserPrincipal(
	c: Context,
	deps: UserPrincipalDependencies,
): Promise<Principal | Response> {
	if (deps.verifier === null) {
		return c.json({ detail: "Cognito verifier is not configured." }, 503);
	}
	return resolvePrincipal(c.req.raw, {
		verifier: deps.verifier,
		directory: new StorePrincipalDirectory(deps.store),
		membershipCache: deps.membershipCache,
		requireEnabledMember: true,
	});
}

/** Whether `resolveUserPrincipal` answered a refusal instead of a principal. */
export function isRefusal(result: Principal | Response): result is Response {
	return result instanceof Response;
}

/** One path parameter of the matched route; a route that declares it always has it. */
export function pathParameter(c: Context, name: string): string {
	const value = c.req.param(name);
	if (value === undefined) {
		throw new Error(`Route is missing path parameter ${name}.`);
	}
	return value;
}
