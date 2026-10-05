import type { Context } from "hono";
import type { IdTokenVerifier } from "../../auth/cognito.ts";
import { MembershipCache } from "../../auth/membership-cache.ts";
import type { CachedMembership } from "../../auth/principal.ts";
import { resolvePrincipal } from "../../auth/principal.ts";
import { StorePrincipalDirectory } from "../../auth/store-principal-directory.ts";
import { OrganizationsKernelImpl } from "../../domain/organizations.ts";
import type { MessagingStore } from "../../store/messaging-store.ts";
import type { Clock, IdSource } from "../app.ts";

/** Response for POST /orgs/{tenant_id}/invitations. */
export interface CreateInvitationResponseBody {
	invitation_id: string;
	email: string;
	expires_at: string;
}

/** Render a date the way Python datetime.isoformat does for a UTC value. */
function isoformatUtc(date: Date): string {
	return date.toISOString().replace(".000Z", "+00:00").replace("Z", "+00:00");
}

/** Per-application membership cache for the invitation route's principal. */
export function createInvitationMembershipCache(clock: Clock): MembershipCache<CachedMembership> {
	return new MembershipCache<CachedMembership>({ nowMilliseconds: () => clock.now().getTime() });
}

/**
 * POST /orgs/{tenant_id}/invitations: an enabled organization's owner invites
 * someone by email. The caller is a user principal resolved from the Cognito
 * id token and the path tenant.
 */
export async function createInvitationHandler(
	c: Context,
	deps: {
		store: MessagingStore;
		clock: Clock;
		ids: IdSource;
		verifier: IdTokenVerifier | null;
		membershipCache: MembershipCache<CachedMembership>;
	},
): Promise<Response> {
	if (deps.verifier === null) {
		return c.json({ detail: "Cognito verifier is not configured." }, 503);
	}
	const principal = await resolvePrincipal(c.req.raw, {
		verifier: deps.verifier,
		directory: new StorePrincipalDirectory(deps.store),
		membershipCache: deps.membershipCache,
		requireEnabledMember: true,
	});
	if (principal.userId === null) {
		return c.json({ detail: "user credential required" }, 403);
	}
	const requestBody = (await c.req.json().catch(() => null)) as { email?: unknown } | null;
	if (requestBody === null || typeof requestBody.email !== "string") {
		return c.json({ detail: "email is required" }, 422);
	}
	const email = requestBody.email.trim();
	if (email === "") {
		return c.json({ detail: "email is required" }, 400);
	}
	const invitation = await new OrganizationsKernelImpl().inviteByEmail(principal.tenantId, principal.userId, email, deps);
	const body: CreateInvitationResponseBody = {
		invitation_id: invitation.invitationId,
		email: invitation.email,
		expires_at: isoformatUtc(invitation.expiresAt),
	};
	return c.json(body, 201);
}
