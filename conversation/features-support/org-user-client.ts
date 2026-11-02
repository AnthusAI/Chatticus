import { orgTenantIdFromPath } from "../src/auth/principal.ts";
import { primaryHumanParticipant } from "../src/domain/channels.ts";
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

const usersPathPattern = /^\/orgs\/[^/]+\/users\/([^/]+)\//;
const turnPathPattern = /^\/orgs\/([^/]+)\/turns\/([^/?]+)/;
const channelPathPattern = /^\/orgs\/([^/]+)\/channels\/([^/?]+)/;

async function actingUserIdFor(world: ChatticusWorld, path: string, body: unknown): Promise<string | null> {
	const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
	if (typeof record.user_id === "string") {
		return record.user_id;
	}
	if (typeof record.author_id === "string" && record.author_kind !== "bot") {
		return record.author_id;
	}
	const usersMatch = usersPathPattern.exec(path);
	if (usersMatch !== null) {
		return decodeURIComponent(usersMatch[1] ?? "");
	}
	const channelMatch = channelPathPattern.exec(path);
	if (channelMatch !== null) {
		const channel = await world.messagingStore().getChannel(channelMatch[1] ?? "", channelMatch[2] ?? "");
		return channel === null ? null : primaryHumanParticipant(channel);
	}
	const turnMatch = turnPathPattern.exec(path);
	if (turnMatch !== null) {
		const tenantId = turnMatch[1] ?? "";
		const turn = await world.turnControlStore().getTurn(tenantId, turnMatch[2] ?? "");
		const channel = turn === null ? null : await world.messagingStore().getChannel(tenantId, turn.channelId);
		return channel === null ? null : primaryHumanParticipant(channel);
	}
	return null;
}

export async function ensureSignedInMember(world: ChatticusWorld, tenantId: string, userId: string): Promise<string> {
	const store = world.messagingStore();
	const email = `${userId}@chatticus.test`;
	if ((await store.getIdentityByEmail(email)) === null) {
		await store.putIdentity({ userId, email, createdAt: world.clock.now() });
	}
	if ((await store.getMembership(tenantId, userId)) === null) {
		await store.putMembership({ tenantId, userId, role: "member", joinedAt: world.clock.now() });
	}
	return email;
}

/**
 * Authorization headers for an enabled member of the organization named in `path`. When the request acts as a named
 * user, the token is that user's own, as the front door now requires; otherwise it is the organization owner's.
 */
export async function organizationMemberHeaders(
	world: ChatticusWorld,
	path: string,
	body: unknown = undefined,
): Promise<Record<string, string>> {
	const tenantId = orgTenantIdFromPath(path);
	if (tenantId === null) {
		throw new Error(`${path} is not an /orgs/{tenant_id}/... path.`);
	}
	const ownerEmail = await ensureTestOrganization(world, tenantId);
	const actingUserId = await actingUserIdFor(world, path, body);
	if (actingUserId === null) {
		return bearerFor(world, ownerEmail);
	}
	return bearerFor(world, await ensureSignedInMember(world, tenantId, actingUserId));
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
	return world.api.post(path, { headers: { ...(await organizationMemberHeaders(world, path, body)), ...headers }, body });
}
