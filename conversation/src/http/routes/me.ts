import type { Context } from "hono";
import type { MessagingStore } from "../../store/messaging-store.ts";
import type { Clock, IdSource } from "../app.ts";
import type { IdTokenVerifier } from "../../auth/cognito.ts";
import { CognitoTokenError } from "../../auth/cognito.ts";
import { OrganizationsKernelImpl } from "../../domain/organizations.ts";
import { InvitationsKernelImpl } from "../../domain/invitations.ts";

export interface MeOrganization {
	tenantId: string;
	name: string;
	status: string;
	role: string;
	monthlyAwsSpendCeilingUsd: string | null;
	computerWorkPaused: boolean;
	computerWorkPausedReason: string | null;
}

export interface MeResponse {
	email: string;
	userId: string;
	organizations: MeOrganization[];
}

/**
 * Parse bearer token from Authorization header.
 */
function parseBearerToken(authHeader: string | null | undefined): string | null {
	if (!authHeader) return null;
	const parts = authHeader.split(" ");
	if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
		return null;
	}
	return parts[1];
}

/**
 * GET /api/me handler - returns current user identity and organizations.
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
		return c.json(
			{ detail: "Cognito verifier is not configured for GET /me." },
			{ status: 503 } as any,
		);
	}

	const token = parseBearerToken(c.req.header("Authorization"));
	if (!token) {
		return c.json({ detail: "user credential required" }, { status: 403 } as any);
	}

	let verified;
	try {
		verified = await deps.verifier.verifyIdToken(token);
	} catch (error) {
		const message = error instanceof CognitoTokenError ? error.message : String(error);
		return c.json({ detail: message }, { status: 403 } as any);
	}

	const orgsKernel = new OrganizationsKernelImpl();
	const invitationsKernel = new InvitationsKernelImpl();

	const identity = await orgsKernel.signIn(verified.email, {
		store: deps.store,
		clock: deps.clock,
		ids: deps.ids,
	});

	await invitationsKernel.reconcilePendingInvitations(identity, {
		store: deps.store,
		clock: deps.clock,
	});

	const organizations = await orgsKernel.listOrganizationsForUser(identity.userId, {
		store: deps.store,
	});

	const membershipPromises = organizations.map(async (org) => {
		const membership = await deps.store.getMembership(org.tenantId, identity.userId);
		return { org, membership };
	});

	const orgWithMemberships = await Promise.all(membershipPromises);

	const meOrganizations: MeOrganization[] = orgWithMemberships.map(({ org, membership }) => ({
		tenantId: org.tenantId,
		name: org.name,
		status: org.status,
		role: membership?.role ?? "unknown",
		monthlyAwsSpendCeilingUsd:
			org.monthlyAwsSpendCeilingUsd !== null ? String(org.monthlyAwsSpendCeilingUsd) : null,
		computerWorkPaused: false,
		computerWorkPausedReason: null,
	}));

	const response: MeResponse = {
		email: identity.email,
		userId: identity.userId,
		organizations: meOrganizations,
	};

	return c.json(response, { status: 200 } as any);
}
