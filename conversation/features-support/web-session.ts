import assert from "node:assert/strict";
import { cognitoKeys } from "./front-door.ts";
import { runMembershipUiHarness } from "./membership-ui-harness.ts";
import type { ChatticusWorld } from "./world.ts";

/**
 * Sign the web SPA in as `email`, an enabled member of the named organization, against the scenario's HTTP front
 * door, and mark the SPA's membership as enabled.
 */
export async function seedEnabledWebSession(world: ChatticusWorld, email: string, name: string): Promise<void> {
	const organization = world.orgsByName?.get(name);
	assert.ok(organization, `No organization named ${JSON.stringify(name)} in this scenario.`);
	assert.ok(world.httpServer, "The front door is not served over HTTP for the web SPA.");
	world.webApiBase = world.httpServer.baseUrl;
	world.webIdToken = await (await cognitoKeys(world)).mintIdToken({ email });
	await runMembershipUiHarness(world, "seed-session", { email, id_token: world.webIdToken });
	await runMembershipUiHarness(world, "set-me-enabled", { tenant_id: organization.tenantId, name: organization.name });
}
