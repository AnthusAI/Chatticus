import type { Context } from "hono";
import { enforceOperatorPrincipal } from "../../auth/operator.ts";
import { OrganizationsKernelImpl } from "../../domain/organizations.ts";
import type { Organization } from "../../domain/organizations.ts";
import type { MessagingStore } from "../../store/messaging-store.ts";
import { pathParameter } from "../user-principal.ts";

/** Response for operator organization lifecycle routes. */
export interface OperatorOrganizationResponseBody {
	tenant_id: string;
	name: string;
	status: string;
}

/** Everything the operator routes depend on. */
export interface OperatorRouteDependencies {
	store: MessagingStore;
	operatorKey: string;
}

/** The lifecycle transition one operator route applies. */
export type OperatorLifecycleAction = "enable" | "suspend" | "reinstate";

const kernel = new OrganizationsKernelImpl();

function operatorOrganizationResponse(organization: Organization): OperatorOrganizationResponseBody {
	return { tenant_id: organization.tenantId, name: organization.name, status: organization.status };
}

/**
 * POST /operator/orgs/{tenant_id}/{enable,suspend,reinstate}: a deployment-wide operator moves one organization
 * through its lifecycle. The caller presents the operator bearer key; nothing else is accepted.
 */
export async function operatorOrganizationHandler(
	c: Context,
	action: OperatorLifecycleAction,
	deps: OperatorRouteDependencies,
): Promise<Response> {
	enforceOperatorPrincipal(c.req.raw, deps.operatorKey);
	const tenantId = pathParameter(c, "tenant_id");
	const organization =
		action === "enable"
			? await kernel.enableOrganization(tenantId, deps)
			: action === "suspend"
				? await kernel.suspendOrganization(tenantId, deps)
				: await kernel.reinstateOrganization(tenantId, deps);
	return c.json(operatorOrganizationResponse(organization), 200);
}
