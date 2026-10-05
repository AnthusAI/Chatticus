import type { Context } from "hono";
import type { MessagingStore } from "../../store/messaging-store.ts";
import type { Clock, IdSource } from "../app.ts";
import { OrganizationsKernelImpl } from "../../domain/organizations.ts";

export interface CreateInvitationRequest {
	email: string;
}

export interface CreateInvitationResponse {
	invitationId: string;
	email: string;
	expiresAt: string;
}

/**
 * POST /api/orgs/{tenant}/invitations handler - creates an invitation.
 */
export async function createInvitationHandler(
	c: Context,
	deps: {
		store: MessagingStore;
		clock: Clock;
		ids: IdSource;
		userId: string | null;
		tenantId: string;
	},
): Promise<Response> {
	if (deps.userId === null) {
		return c.json({ detail: "user credential required" }, { status: 403 } as any);
	}

	let bodyData;
	try {
		bodyData = await c.req.json();
	} catch {
		return c.json({ detail: "invalid request body" }, { status: 400 } as any);
	}

	const email = (bodyData.email || "").trim();
	if (!email) {
		return c.json({ detail: "email is required" }, { status: 400 } as any);
	}

	const orgsKernel = new OrganizationsKernelImpl();

	try {
		const invitation = await orgsKernel.inviteByEmail(
			deps.tenantId,
			deps.userId,
			email,
			{
				store: deps.store,
				clock: deps.clock,
				ids: deps.ids,
			},
		);

		const response: CreateInvitationResponse = {
			invitationId: invitation.invitationId,
			email: invitation.email,
			expiresAt: invitation.expiresAt.toISOString(),
		};

		return c.json(response, { status: 201 } as any);
	} catch (error) {
		if (error instanceof Error) {
			const statusCode = error.name === "NotOrganizationOwnerError" ? 403 : 404;
			return c.json({ detail: error.message }, { status: statusCode } as any);
		}
		throw error;
	}
}
