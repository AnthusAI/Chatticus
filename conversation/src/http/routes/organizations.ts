import type { Context } from "hono";
import type { MessagingStore } from "../../store/messaging-store.ts";
import type { Clock, IdSource } from "../app.ts";
import type { IdTokenVerifier } from "../../auth/cognito.ts";
import { CognitoTokenError } from "../../auth/cognito.ts";
import { OrganizationsKernelImpl } from "../../domain/organizations.ts";
import { validateOrganizationName } from "../../domain/creation-limits.ts";
import {
	OrganizationOwnerCapError,
	OrganizationCreationRateLimitedError,
} from "../errors.ts";
import type { SignupMode } from "../../domain/signup-mode.ts";

export interface CreateOrganizationRequest {
	name: string;
}

export interface CreateOrganizationResponse {
	tenantId: string;
	name: string;
	status: string;
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
 * POST /api/organizations handler - creates a new organization.
 */
export async function createOrganizationHandler(
	c: Context,
	deps: {
		store: MessagingStore;
		clock: Clock;
		ids: IdSource;
		verifier: IdTokenVerifier | null;
		signupMode: SignupMode;
	},
): Promise<Response> {
	if (deps.signupMode !== "open") {
		return c.json(
			{ detail: "organization creation is not enabled on this deployment" },
			{ status: 403 } as any,
		);
	}

	if (deps.verifier === null) {
		return c.json(
			{ detail: "Cognito verifier is not configured for POST /organizations." },
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

	let bodyData;
	try {
		bodyData = await c.req.json();
	} catch {
		return c.json({ detail: "invalid request body" }, { status: 400 } as any);
	}

	const name = (bodyData.name || "").trim();
	if (!name) {
		return c.json({ detail: "organization name is required" }, { status: 400 } as any);
	}

	try {
		validateOrganizationName(name);
	} catch (error) {
		return c.json(
			{ detail: error instanceof Error ? error.message : String(error) },
			{ status: 400 } as any,
		);
	}

	const orgsKernel = new OrganizationsKernelImpl();

	const owner = await orgsKernel.signIn(verified.email, {
		store: deps.store,
		clock: deps.clock,
		ids: deps.ids,
	});

	const ownedOrganizations = await orgsKernel.listOrganizationsForUser(owner.userId, {
		store: deps.store,
	});

	if (ownedOrganizations.length >= 1) {
		throw new OrganizationOwnerCapError(
			`User ${JSON.stringify(owner.userId)} has reached the organization creation cap.`,
		);
	}

	const organization = await orgsKernel.createOrganization(owner, name, {
		store: deps.store,
		clock: deps.clock,
		ids: deps.ids,
	});

	const response: CreateOrganizationResponse = {
		tenantId: organization.tenantId,
		name: organization.name,
		status: organization.status,
	};

	return c.json(response, { status: 201 } as any);
}
