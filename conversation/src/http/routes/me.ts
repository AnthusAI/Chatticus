import type { Context } from "hono";
import type { IdTokenVerifier } from "../../auth/cognito.ts";
import { CognitoTokenError } from "../../auth/cognito.ts";
import { parseBearerToken } from "../../auth/principal.ts";
import { InvitationsKernelImpl } from "../../domain/invitations.ts";
import { OrganizationsKernelImpl } from "../../domain/organizations.ts";
import type { MessagingStore } from "../../store/messaging-store.ts";
import type { Clock, IdSource } from "../app.ts";

/** One organization row in GET /me. */
export interface MeOrganizationBody {
	tenant_id: string;
	name: string;
	status: string;
	role: string;
	monthly_aws_spend_ceiling_usd: string | null;
	computer_work_paused: boolean;
	computer_work_paused_reason: string | null;
}

/** Membership snapshot for the signed-in user. */
export interface MeResponseBody {
	email: string;
	user_id: string | null;
	organizations: MeOrganizationBody[];
}

/**
 * GET /me: map one Cognito id token to identity and organizations without a
 * path tenant. A valid token mints an identity on first sight, reconciles
 * pending invitations, and returns empty organizations when none apply.
 */
export async function getMeHandler(
	c: Context,
	deps: {
		store: MessagingStore;
		clock: Clock;
		ids: IdSource;
		verifier: IdTokenVerifier | null;
	},
): Promise<Response> {
	if (deps.verifier === null) {
		return c.json({ detail: "Cognito verifier is not configured for GET /me." }, 503);
	}
	const token = parseBearerToken(c.req.header("Authorization") ?? null);
	if (token === null) {
		return c.json({ detail: "user credential required" }, 403);
	}
	let verifiedEmail: string;
	try {
		verifiedEmail = (await deps.verifier.verifyIdToken(token)).email;
	} catch (error) {
		if (error instanceof CognitoTokenError) {
			return c.json({ detail: error.message }, 403);
		}
		throw error;
	}
	const organizationsKernel = new OrganizationsKernelImpl();
	const identity = await organizationsKernel.signIn(verifiedEmail, deps);
	await new InvitationsKernelImpl().reconcilePendingInvitations(identity, deps);
	const organizations = await organizationsKernel.listOrganizationsForUser(identity.userId, deps);
	const rows: MeOrganizationBody[] = [];
	for (const organization of organizations) {
		const membership = await deps.store.getMembership(organization.tenantId, identity.userId);
		if (membership === null) {
			throw new Error(`Membership is missing for ${identity.userId} in ${organization.tenantId}.`);
		}
		const isOwner = membership.role === "owner";
		rows.push({
			tenant_id: organization.tenantId,
			name: organization.name,
			status: organization.status,
			role: membership.role,
			monthly_aws_spend_ceiling_usd:
				isOwner && organization.monthlyAwsSpendCeilingUsd !== null
					? String(organization.monthlyAwsSpendCeilingUsd)
					: null,
			computer_work_paused: false,
			computer_work_paused_reason: null,
		});
	}
	const body: MeResponseBody = {
		email: verifiedEmail,
		user_id: identity.userId,
		organizations: rows,
	};
	return c.json(body, 200);
}
