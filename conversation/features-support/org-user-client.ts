import { orgTenantIdFromPath } from "../src/auth/principal.ts";
import { OrganizationsKernelImpl } from "../src/domain/organizations.ts";
import { bearerFor } from "./front-door.ts";
import type { ChatticusWorld } from "./world.ts";

const DEFAULT_OWNER_EMAIL = "owner@chatticus.test";
const kernel = new OrganizationsKernelImpl();

/**
 * Seed one enabled organization for `tenantId` when it does not exist yet, and return the email of the member
 * whose id token the scenario presents. Mirrors the Python ensure_test_org helper.
 */
export async function ensureTestOrganization(world: ChatticusWorld, tenantId: string): Promise<string> {
	const known = world.testOwnerEmails.get(tenantId);
	if (known !== undefined) {
		return known;
	}
	const store = world.messagingStore();
	const existing = await store.getOrganization(tenantId);
	if (existing === null) {
		await kernel.adminSeedOrganization(tenantId, DEFAULT_OWNER_EMAIL, tenantId, {
			store,
			clock: world.clock,
			ids: world.ids,
		});
	}
	world.testOwnerEmails.set(tenantId, DEFAULT_OWNER_EMAIL);
	return DEFAULT_OWNER_EMAIL;
}

/** Authorization headers for an enabled member of the organization named in `path`. */
export async function organizationMemberHeaders(world: ChatticusWorld, path: string): Promise<Record<string, string>> {
	const tenantId = orgTenantIdFromPath(path);
	if (tenantId === null) {
		throw new Error(`${path} is not an /orgs/{tenant_id}/... path.`);
	}
	return bearerFor(world, await ensureTestOrganization(world, tenantId));
}

/** GET `path` through the scenario's HTTP application as an enabled member of the path's organization. */
export async function memberGet(world: ChatticusWorld, path: string): Promise<Response> {
	if (world.api === null) {
		throw new Error("The scenario has no HTTP front door.");
	}
	return world.api.get(path, { headers: await organizationMemberHeaders(world, path) });
}

/** POST `body` to `path` through the scenario's HTTP application as an enabled member of the path's organization. */
export async function memberPost(
	world: ChatticusWorld,
	path: string,
	body: unknown,
	headers: Record<string, string> = {},
): Promise<Response> {
	if (world.api === null) {
		throw new Error("The scenario has no HTTP front door.");
	}
	return world.api.post(path, { headers: { ...(await organizationMemberHeaders(world, path)), ...headers }, body });
}
