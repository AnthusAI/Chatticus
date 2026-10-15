import type { Context } from "hono";
import type { IdTokenVerifier } from "../auth/cognito.ts";
import { integrationTestAuthenticator, type IntegrationTestAuthConfig } from "../auth/integration-test.ts";
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
	integrationTest: IntegrationTestAuthConfig | null;
}

/** Per-application membership cache for organization user routes. */
export function createUserMembershipCache(clock: Clock): MembershipCache<CachedMembership> {
	return new MembershipCache<CachedMembership>({ nowMilliseconds: () => clock.now().getTime() });
}

/**
 * Resolve the organization member calling an /orgs/{tenant_id}/... user route, or answer the refusal. Only
 * waitlist-safe routes, which a pending organization's members may call, pass `requireEnabledMember: false`.
 *
 * @returns The principal, or the response to return when the caller is refused or the verifier is not configured.
 */
export async function resolveUserPrincipal(
	c: Context,
	deps: UserPrincipalDependencies,
	options: { requireEnabledMember: boolean } = { requireEnabledMember: true },
): Promise<Principal | Response> {
	if (deps.verifier === null) {
		return c.json({ detail: "Cognito verifier is not configured." }, 503);
	}
	const directory = new StorePrincipalDirectory(deps.store);
	return resolvePrincipal(c.req.raw, {
		verifier: deps.verifier,
		directory,
		membershipCache: deps.membershipCache,
		requireEnabledMember: options.requireEnabledMember,
		...(deps.integrationTest === null
			? {}
			: { integrationTestAuthenticator: integrationTestAuthenticator(directory, deps.integrationTest) }),
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
