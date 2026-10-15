import assert from "node:assert/strict";
import { Given, Then, When, defineParameterType } from "@cucumber/cucumber";
import { OrganizationsKernelImpl } from "../../src/domain/organizations.ts";
import { getRegisteredRoutes } from "../../src/http/route-audience.ts";
import { bearerFor, wireFrontDoor } from "../front-door.ts";
import type { ChatticusWorld } from "../world.ts";

const kernel = new OrganizationsKernelImpl();
const WAITLIST_MEMBER_EMAIL = "waiting@example.com";
const WAITLIST_TENANT_ID = "waitlisted";

defineParameterType({
	name: "path",
	regexp: /"([^"]+)"/,
	transformer: (s: string) => s,
});

When(
	"the front door receives GET \\/orgs\\/{word}\\/users\\/{word}\\/bots with header X-Tenant-Id {word}",
	async function (this: ChatticusWorld, tenantId: string, userId: string, headerTenant: string) {
		assert.ok(this.api, "No API client");
		this.lastHttpResponse = await this.api.get(`/orgs/${tenantId}/users/${userId}/bots`, {
			headers: { "X-Tenant-Id": headerTenant },
		});
	},
);

Then("the front door rejects X-Tenant-Id", async function (this: ChatticusWorld) {
	const response = this.lastHttpResponse;
	assert.ok(response, "No last HTTP response");
	assert.equal(response.status, 400);
	const data = await response.json();
	assert.ok(data.detail?.includes("X-Tenant-Id"), `Expected X-Tenant-Id in detail: ${data.detail}`);
});

Given(
	"a front door serving named environment {string} with HTTP",
	async function (this: ChatticusWorld, environment: string) {
		this.environment = environment;
		await wireFrontDoor(this, { signupMode: "invitation_only", cognitoVerifier: true, environment });
	},
);

Then("GET \\/health reports environment {string}", async function (this: ChatticusWorld, expectedEnvironment: string) {
	assert.ok(this.api, "No API client");
	const response = await this.api.get("/health");
	assert.equal(response.status, 200);
	const data = await response.json();
	assert.equal(data.status, "ok");
	assert.equal(data.environment, expectedEnvironment);
});

Then("{path} is outside the principal marker system", async function (this: ChatticusWorld, path: string) {
	await wireFrontDoor(this, { signupMode: "invitation_only", cognitoVerifier: true });
	assert.ok(this.api, "No API client");
	const registered = getRegisteredRoutes().filter((route) => route.path === path);
	assert.deepEqual(registered, [], `Path ${path} is registered with a principal audience`);
	const unauthenticated = await this.api.get(path);
	assert.equal(unauthenticated.status, 404, `Path ${path} must not resolve a principal`);
	const guarded = await this.api.get("/orgs/anthus/bots");
	assert.equal(guarded.status, 403, "A principal route must refuse a caller without credentials");
});

Then("{path} is a named waitlist-safe route", async function (this: ChatticusWorld, path: string) {
	await wireFrontDoor(this, { signupMode: "invitation_only", cognitoVerifier: true });
	assert.ok(this.api, "No API client");
	const registered = getRegisteredRoutes().filter((route) => route.path === path && route.method === "GET");
	assert.ok(registered.length >= 1, `Path ${path} is not a registered route`);
	const dependencies = { store: this.messagingStore(), clock: this.clock, ids: this.ids };
	await kernel.adminSeedOrganization(WAITLIST_TENANT_ID, WAITLIST_MEMBER_EMAIL, WAITLIST_TENANT_ID, dependencies);
	await kernel.suspendOrganization(WAITLIST_TENANT_ID, dependencies);
	const headers = await bearerFor(this, WAITLIST_MEMBER_EMAIL);
	const refused = await this.api.get(`/orgs/${WAITLIST_TENANT_ID}/bots`, { headers });
	assert.equal(refused.status, 403, "A member of a non-enabled organization must be refused on an enabled-only route");
	const allowed = await this.api.get(path, { headers });
	assert.equal(allowed.status, 200, `Path ${path} must answer a member of a non-enabled organization`);
	const body = await allowed.json();
	assert.deepEqual(
		body.organizations.map((organization: { tenant_id: string; status: string }) => [organization.tenant_id, organization.status]),
		[[WAITLIST_TENANT_ID, "suspended"]],
	);
});
