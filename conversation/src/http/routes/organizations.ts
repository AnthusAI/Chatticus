import type { Context } from "hono";
import type { IdTokenVerifier } from "../../auth/cognito.ts";
import { CognitoTokenError } from "../../auth/cognito.ts";
import { parseBearerToken } from "../../auth/principal.ts";
import { createOrganizationUnderCaps } from "../../domain/creation-limits.ts";
import { OrganizationsKernelImpl } from "../../domain/organizations.ts";
import type { SignupMode } from "../../domain/signup-mode.ts";
import type { MessagingStore } from "../../store/messaging-store.ts";
import type { Clock, IdSource } from "../app.ts";

/** Response for POST /organizations. */
export interface CreateOrganizationResponseBody {
	tenant_id: string;
	name: string;
	status: string;
}

/**
 * POST /organizations: create a pending organization for the signed-in person
 * on a deployment with open signup, under the owner cap, the name limit and
 * the creation rate limit.
 */
export async function createOrganizationHandler(
	c: Context,
	deps: {
		store: MessagingStore;
		clock: Clock;
		ids: IdSource;
		verifier: IdTokenVerifier | null;
		signupMode: SignupMode;
		organizationCreationRateLimit: number;
	},
): Promise<Response> {
	if (deps.signupMode !== "open") {
		return c.json({ detail: "organization creation is not enabled on this deployment" }, 403);
	}
	if (deps.verifier === null) {
		return c.json({ detail: "Cognito verifier is not configured for POST /organizations." }, 503);
	}
	const token = parseBearerToken(c.req.header("Authorization") ?? null);
	if (token === null) {
		return c.json({ detail: "user credential required" }, 403);
	}
	const requestBody = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
	if (requestBody === null || typeof requestBody.name !== "string") {
		return c.json({ detail: "name is required" }, 422);
	}
	const name = requestBody.name.trim();
	if (name === "") {
		return c.json({ detail: "organization name is required" }, 400);
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
	const owner = await new OrganizationsKernelImpl().signIn(verifiedEmail, deps);
	const organization = await createOrganizationUnderCaps(owner, name, {
		store: deps.store,
		clock: deps.clock,
		ids: deps.ids,
		rateLimit: deps.organizationCreationRateLimit,
	});
	const body: CreateOrganizationResponseBody = {
		tenant_id: organization.tenantId,
		name: organization.name,
		status: organization.status,
	};
	return c.json(body, 201);
}
