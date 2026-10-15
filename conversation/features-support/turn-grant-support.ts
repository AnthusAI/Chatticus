import assert from "node:assert/strict";
import type { DataTable } from "@cucumber/cucumber";
import { type MemberRole, normalizeEmail } from "../src/domain/organizations.ts";
import { type TaskCapabilityGrant, grantToPayload, householdConversationGrant } from "../src/policy/capability-policy.ts";
import { turnCapabilityGrant } from "../src/policy/turn-grant.ts";
import { type RecordedResponse, recordResponse } from "./api.ts";
import { bearerFor } from "./front-door.ts";
import { ensureTestOrganization, organizationMemberHeaders } from "./org-user-client.ts";
import type { ChatticusWorld } from "./world.ts";

/** The grant table of a Gherkin step as a map from field to value. */
export function grantTableOf(table: DataTable): Record<string, string> {
	const values: Record<string, string> = {};
	for (const row of table.raw()) values[(row[0] ?? "").trim()] = (row[1] ?? "").trim();
	return values;
}

/** The body of PUT /turns/{id}/grant for a grant table, split on commas as the web form splits it. */
export function grantPayloadOfTable(values: Record<string, string>): Record<string, string[]> {
	const split = (field: string): string[] =>
		(values[field] ?? "")
			.split(",")
			.map((part) => part.trim())
			.filter((part) => part !== "");
	return {
		tools: split("tools"),
		origins: split("origins"),
		recipients: split("recipients"),
		file_scopes: split("file_scopes"),
		egress_classes: split("egress_classes"),
		ingest_classes: split("ingest_classes"),
	};
}

/**
 * Make `userId` a member of the organization, creating the organization and the member's identity when the scenario has
 * none yet, and return the email the member signs in with.
 */
export async function ensureMember(
	world: ChatticusWorld,
	tenantId: string,
	userId: string,
	role: MemberRole = "owner",
): Promise<string> {
	await ensureTestOrganization(world, tenantId);
	const store = world.messagingStore();
	const email = normalizeEmail(`${userId}@${tenantId}.test`);
	if ((await store.getIdentityByEmail(email)) === null) {
		await store.putIdentity({ userId, email, createdAt: world.clock.now() });
	}
	if ((await store.getMembership(tenantId, userId)) === null) {
		await store.putMembership({ tenantId, userId, role, joinedAt: world.clock.now() });
	}
	return email;
}

/** Authorization headers of the member `userId` of `tenantId`, who is made a member first when the scenario has not. */
export async function memberHeadersFor(
	world: ChatticusWorld,
	tenantId: string,
	userId: string,
): Promise<Record<string, string>> {
	return bearerFor(world, await ensureMember(world, tenantId, userId));
}

/** The active turn of the scenario and its organization. */
export function activeTurnOf(world: ChatticusWorld): { tenantId: string; turnId: string } {
	assert.ok(world.lastTurnId, "No turn is active in this scenario.");
	const tenantId = world.lastChannel?.tenantId ?? [...(world.botsByName?.values() ?? [])][0]?.tenantId ?? "anthus";
	return { tenantId, turnId: world.lastTurnId };
}

/** The grant the active turn carries now, read through the same domain function the grant route uses. */
export async function activeTurnGrant(world: ChatticusWorld): Promise<TaskCapabilityGrant | null> {
	const { tenantId, turnId } = activeTurnOf(world);
	return turnCapabilityGrant({ turns: world.turnDependencies() }, tenantId, turnId);
}

/** PUT a grant body to the active turn's grant route and keep the response on the world. */
export async function putActiveTurnGrant(
	world: ChatticusWorld,
	headers: Record<string, string>,
	payload: Record<string, string[]>,
	tenantId?: string,
): Promise<RecordedResponse> {
	assert.ok(world.api, "The scenario has no HTTP front door.");
	const active = activeTurnOf(world);
	const response = await recordResponse(
		await world.api.put(`/orgs/${tenantId ?? active.tenantId}/turns/${active.turnId}/grant`, { headers, body: payload }),
	);
	world.grantResponse = response;
	return response;
}

/**
 * The active turn's journal events that replaced its grant, read through the events route as the member the scenario
 * signed in (the web SPA's member) or else as the scenario's default member.
 */
export async function grantReplacementEvents(world: ChatticusWorld): Promise<Array<Record<string, any>>> {
	assert.ok(world.api, "The scenario has no HTTP front door.");
	const { tenantId, turnId } = activeTurnOf(world);
	const headers =
		world.currentIdentity === null
			? await organizationMemberHeaders(world, `/orgs/${tenantId}/turns/${turnId}/events`)
			: await bearerFor(world, world.currentIdentity.email);
	const response = await recordResponse(await world.api.get(`/orgs/${tenantId}/turns/${turnId}/events`, { headers }));
	assert.equal(response.status, 200, response.text);
	return response.json.events.filter((event: Record<string, any>) => event.kind === "turn.grant.replaced");
}

/** Whether two grants allow exactly the same things. */
export function sameGrant(left: TaskCapabilityGrant, right: TaskCapabilityGrant): boolean {
	return JSON.stringify(grantToPayload(left)) === JSON.stringify(grantToPayload(right));
}

/** Whether a grant is the household conversation grant. */
export const isHouseholdConversationGrant = (grant: TaskCapabilityGrant | null): boolean =>
	grant !== null && sameGrant(grant, householdConversationGrant());
