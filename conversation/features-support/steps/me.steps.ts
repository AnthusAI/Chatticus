import assert from "node:assert/strict";
import { Given, Then, When, type DataTable } from "@cucumber/cucumber";
import { OrganizationsKernelImpl } from "../../src/domain/organizations.ts";
import { recordResponse } from "../api.ts";
import { bearerFor, cognitoKeys, wireFrontDoor } from "../front-door.ts";
import type { ChatticusWorld } from "../world.ts";

const kernel = new OrganizationsKernelImpl();

function meBody(world: ChatticusWorld): any {
	assert.ok(world.meResponse, "GET /me has not been called in this scenario");
	return world.meResponse.json;
}

Given("a Cognito-verified HTTP front door", async function (this: ChatticusWorld) {
	await wireFrontDoor(this, { signupMode: "invitation_only", cognitoVerifier: true });
});

Given("an HTTP front door without a Cognito verifier", async function (this: ChatticusWorld) {
	await wireFrontDoor(this, { signupMode: "invitation_only", cognitoVerifier: false });
});

Given(
	"the me front door has tenant {string} enabled for {string}",
	async function (this: ChatticusWorld, tenantId: string, email: string) {
		await kernel.adminSeedOrganization(tenantId, email, "Test Org", {
			store: this.messagingStore(),
			clock: this.clock,
			ids: this.ids,
		});
	},
);

Given("{string} has signed in on the me front door", async function (this: ChatticusWorld, email: string) {
	const identity = await kernel.signIn(email, {
		store: this.messagingStore(),
		clock: this.clock,
		ids: this.ids,
	});
	this.currentIdentity = identity;
	this.identitiesByEmail?.set(email, identity);
});

When("GET \\/me is called without Authorization", async function (this: ChatticusWorld) {
	assert.ok(this.api);
	this.meResponse = await recordResponse(await this.api.get("/me"));
});

When("GET \\/me is called with bearer token {string}", async function (this: ChatticusWorld, token: string) {
	assert.ok(this.api);
	this.meResponse = await recordResponse(
		await this.api.get("/me", { headers: { Authorization: `Bearer ${token}` } }),
	);
});

When(
	"GET \\/me is called with a valid id token for {string}",
	async function (this: ChatticusWorld, email: string) {
		assert.ok(this.api);
		this.meResponse = await recordResponse(await this.api.get("/me", { headers: await bearerFor(this, email) }));
	},
);

When(
	"GET \\/me is called with an expired id token for {string}",
	async function (this: ChatticusWorld, email: string) {
		assert.ok(this.api);
		const keys = await cognitoKeys(this);
		const token = await keys.mintIdToken({ email, expiresAtSeconds: Math.floor(Date.UTC(2020, 0, 1) / 1000) });
		this.meResponse = await recordResponse(
			await this.api.get("/me", { headers: { Authorization: `Bearer ${token}` } }),
		);
	},
);

Then("GET \\/me responds with status {int}", function (this: ChatticusWorld, status: number) {
	assert.ok(this.meResponse, "GET /me has not been called in this scenario");
	assert.equal(this.meResponse.status, status, this.meResponse.text);
});

Then("GET \\/me email is {string}", function (this: ChatticusWorld, email: string) {
	assert.equal(meBody(this).email, email);
});

Then("GET \\/me user id is present", function (this: ChatticusWorld) {
	const userId = meBody(this).user_id;
	assert.equal(typeof userId, "string");
	assert.ok(userId.length > 0);
});

Then("GET \\/me organizations are empty", function (this: ChatticusWorld) {
	assert.deepEqual(meBody(this).organizations, []);
});

Then("GET \\/me organizations include one with status {string}", function (this: ChatticusWorld, status: string) {
	const organizations = meBody(this).organizations;
	assert.equal(organizations.length, 1);
	assert.equal(organizations[0].status, status);
});

Then("GET \\/me organizations include:", function (this: ChatticusWorld, table: DataTable) {
	const organizations: Array<Record<string, unknown>> = meBody(this).organizations;
	const expectedRows = table.hashes();
	assert.equal(organizations.length, expectedRows.length);
	for (const expected of expectedRows) {
		const matchKey = expected.tenant_id ? "tenant_id" : "name";
		const matches = organizations.filter((organization) => organization[matchKey] === expected[matchKey]);
		assert.equal(matches.length, 1, `expected one organization with ${matchKey} ${expected[matchKey]}, got ${JSON.stringify(organizations)}`);
		for (const [key, value] of Object.entries(expected)) {
			assert.equal(matches[0]![key], value);
		}
		if (!expected.tenant_id) {
			assert.ok(matches[0]!.tenant_id);
		}
	}
});
