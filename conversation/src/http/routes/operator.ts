import type { Context } from "hono";
import { enforceOperatorPrincipal } from "../../auth/operator.ts";
import { OrganizationsKernelImpl } from "../../domain/organizations.ts";
import type { Organization } from "../../domain/organizations.ts";
import type { ChannelsRuntime } from "../../channels/runtime.ts";
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
	/** The deployment account an enabled organization with no chosen setup path is homed in. */
	deploymentAwsAccountId?: string;
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
	const lifecycle = {
		store: deps.store,
		...(deps.deploymentAwsAccountId === undefined ? {} : { callerAwsAccountId: async () => deps.deploymentAwsAccountId! }),
	};
	const organization =
		action === "enable"
			? await kernel.enableOrganization(tenantId, lifecycle)
			: action === "suspend"
				? await kernel.suspendOrganization(tenantId, lifecycle)
				: await kernel.reinstateOrganization(tenantId, lifecycle);
	return c.json(operatorOrganizationResponse(organization), 200);
}

/** Everything the operator external channels routes depend on. */
export interface OperatorExternalChannelsDependencies {
	store: MessagingStore;
	operatorKey: string;
	/** Present only where external channels are rolled out; absent, the route answers 404. */
	channels: ChannelsRuntime | null;
}

/**
 * POST /operator/orgs/{tenant_id}/external-channels/{enable,disable}: the operator switches external channels on or off
 * for one organization. The caller presents the operator bearer key; nothing else is accepted.
 */
export async function operatorExternalChannelsHandler(
	c: Context,
	action: "enable" | "disable",
	deps: OperatorExternalChannelsDependencies,
): Promise<Response> {
	enforceOperatorPrincipal(c.req.raw, deps.operatorKey);
	if (deps.channels === null) return c.json({ detail: "Not found.", code: "not_found" }, 404);
	const tenantId = pathParameter(c, "tenant_id");
	const organization = await deps.store.getOrganization(tenantId);
	if (organization === null) return c.json({ detail: "Not found.", code: "not_found" }, 404);
	await deps.channels.store.setExternalChannelsEnabled(tenantId, action === "enable");
	return c.json({ tenant_id: tenantId, external_channels_enabled: action === "enable" }, 200);
}
