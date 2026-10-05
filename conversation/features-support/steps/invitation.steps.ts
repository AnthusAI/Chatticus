import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { normalizeEmail } from "../../src/domain/organizations.ts";
import { recordResponse } from "../api.ts";
import { bearerFor, cognitoKeys } from "../front-door.ts";
import { runMembershipUiHarness } from "../membership-ui-harness.ts";
import type { ChatticusWorld } from "../world.ts";

async function inviteAsCurrentUser(world: ChatticusWorld, name: string, email: string): Promise<void> {
	const organization = world.orgsByName?.get(name);
	assert.ok(organization, `No organization named ${JSON.stringify(name)} in this scenario.`);
	assert.ok(world.currentIdentity, "No current user in this scenario.");
	assert.ok(world.api);
	world.inviteResponse = await recordResponse(
		await world.api.post(`/orgs/${organization.tenantId}/invitations`, {
			headers: await bearerFor(world, world.currentIdentity.email),
			body: { email },
		}),
	);
}

function harnessState(world: ChatticusWorld): Record<string, any> {
	assert.ok(world.membershipUiHarness, "The web SPA harness has not run in this scenario.");
	return world.membershipUiHarness;
}

When(
	"the owner of {string} invites {string} via the HTTP front door",
	async function (this: ChatticusWorld, name: string, email: string) {
		await inviteAsCurrentUser(this, name, email);
	},
);

Given(
	"the owner of {string} has invited {string} via the HTTP front door",
	async function (this: ChatticusWorld, name: string, email: string) {
		await inviteAsCurrentUser(this, name, email);
	},
);

When(
	"a member of {string} tries to invite {string} via the HTTP front door",
	async function (this: ChatticusWorld, name: string, email: string) {
		await inviteAsCurrentUser(this, name, email);
	},
);

Given("the invitation TTL has elapsed", function (this: ChatticusWorld) {
	this.clock.advanceSeconds(8 * 24 * 60 * 60);
});

When("{string} is the current user on the me front door", async function (this: ChatticusWorld, email: string) {
	const identity = await this.messagingStore().getIdentityByEmail(normalizeEmail(email));
	assert.ok(identity, `No identity exists for ${email}`);
	this.currentIdentity = identity;
	this.identitiesByEmail?.set(email, identity);
});

Then("POST \\/orgs\\/invitations responds with status {int}", function (this: ChatticusWorld, status: number) {
	assert.ok(this.inviteResponse, "No invitation has been posted in this scenario");
	assert.equal(this.inviteResponse.status, status, this.inviteResponse.text);
});

Then("GET \\/me does not include a pending organization", function (this: ChatticusWorld) {
	assert.ok(this.meResponse, "GET /me has not been called in this scenario");
	const pending = this.meResponse.json.organizations.filter(
		(organization: { status: string }) => organization.status === "pending",
	);
	assert.deepEqual(pending, []);
});

Given(
	"the web SPA has an enabled organization session for {string} in {string}",
	async function (this: ChatticusWorld, email: string, name: string) {
		const organization = this.orgsByName?.get(name);
		assert.ok(organization, `No organization named ${JSON.stringify(name)} in this scenario.`);
		assert.ok(this.httpServer, "The front door is not served over HTTP for the web SPA.");
		this.webApiBase = this.httpServer.baseUrl;
		this.webIdToken = await (await cognitoKeys(this)).mintIdToken({ email });
		await runMembershipUiHarness(this, "seed-session", { email, id_token: this.webIdToken });
		await runMembershipUiHarness(this, "set-me-enabled", { tenant_id: organization.tenantId, name: organization.name });
	},
);

Given("the web SPA has a signed-in session for {string}", async function (this: ChatticusWorld, email: string) {
	this.webIdToken = await (await cognitoKeys(this)).mintIdToken({ email });
	await runMembershipUiHarness(this, "seed-session", { email, id_token: this.webIdToken });
});

When("the web SPA owner of {string} invites {string}", async function (this: ChatticusWorld, name: string, email: string) {
	const organization = this.orgsByName?.get(name);
	assert.ok(organization, `No organization named ${JSON.stringify(name)} in this scenario.`);
	assert.ok(this.currentIdentity, "No current user in this scenario.");
	assert.ok(this.webApiBase);
	const token = await (await cognitoKeys(this)).mintIdToken({ email: this.currentIdentity.email });
	await runMembershipUiHarness(this, "submit-invitation", {
		api_base: this.webApiBase,
		id_token: token,
		tenant_id: organization.tenantId,
		email,
	});
});

When("the web SPA refreshes membership from GET \\/me", async function (this: ChatticusWorld) {
	assert.ok(this.webApiBase);
	assert.ok(this.webIdToken);
	await runMembershipUiHarness(this, "refresh-me-from-api", {
		api_base: this.webApiBase,
		id_token: this.webIdToken,
		email: harnessState(this).email,
	});
});

When("the web SPA renders the membership shell", async function (this: ChatticusWorld) {
	await runMembershipUiHarness(this, "render-shell");
});

Then("the web SPA shows invite confirmation for {string}", function (this: ChatticusWorld, email: string) {
	const expected = `Invited ${normalizeEmail(email)} — they can sign in with that Google account.`;
	assert.equal(harnessState(this).inviteConfirmation, expected);
});

Then("the web SPA shows the enabled workspace", function (this: ChatticusWorld) {
	assert.equal(harnessState(this).view, "enabled-workspace", JSON.stringify(harnessState(this)));
});

Then("the web SPA does not show the welcome screen", function (this: ChatticusWorld) {
	assert.notEqual(harnessState(this).view, "welcome", JSON.stringify(harnessState(this)));
});

Then(
	"the web SPA shows organization {string} with status {string} and tenant_id present",
	function (this: ChatticusWorld, name: string, status: string) {
		const state = harnessState(this);
		const text: string = state.visibleText ?? "";
		const organization = (state.me?.organizations ?? []).find((row: { name: string }) => row.name === name);
		assert.ok(organization, JSON.stringify(state));
		assert.ok(organization.tenant_id, JSON.stringify(state));
		assert.ok(text.includes(name), JSON.stringify(state));
		assert.ok(text.includes(status), JSON.stringify(state));
		assert.ok(text.includes(organization.tenant_id), JSON.stringify(state));
	},
);
