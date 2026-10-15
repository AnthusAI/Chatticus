import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { OrganizationsKernelImpl } from "../../src/domain/organizations.ts";
import { runMembershipUiHarness } from "../membership-ui-harness.ts";
import type { ChatticusWorld } from "../world.ts";

const kernel = new OrganizationsKernelImpl();

When("the web SPA submits organization name {string}", async function (this: ChatticusWorld, name: string) {
	assert.ok(this.webApiBase, "web API base is not wired for this scenario");
	const payload: Record<string, string> = { name, api_base: this.webApiBase };
	if (this.webIdToken) {
		payload.id_token = this.webIdToken;
	}
	await runMembershipUiHarness(this, "submit-organization", payload);
});

Then("the web SPA shows the welcome screen", function (this: ChatticusWorld) {
	assert.ok(this.membershipUiHarness, "The web SPA harness has not run in this scenario.");
	assert.equal(this.membershipUiHarness.view, "welcome", JSON.stringify(this.membershipUiHarness));
});

Given("the web SPA membership module with signup mode {string}", async function (this: ChatticusWorld, mode: string) {
	await runMembershipUiHarness(this, "reset", { signup_mode: mode });
});

Given("GET \\/me reports no organizations for that session", async function (this: ChatticusWorld) {
	await runMembershipUiHarness(this, "set-me-empty");
});

function webState(world: ChatticusWorld): Record<string, any> {
	assert.ok(world.membershipUiHarness, "The web SPA harness has not run in this scenario.");
	return world.membershipUiHarness;
}

function visibleText(world: ChatticusWorld): string {
	return webState(world).visibleText ?? "";
}

Then("the web SPA shows the create organization form", function (this: ChatticusWorld) {
	assert.equal(webState(this).view, "create-organization", JSON.stringify(webState(this)));
});

Then("the web SPA does not show the invitation-only panel", function (this: ChatticusWorld) {
	assert.notEqual(webState(this).view, "invitation-only", JSON.stringify(webState(this)));
});

Then("the web SPA shows the invitation-only panel", function (this: ChatticusWorld) {
	assert.equal(webState(this).view, "invitation-only", JSON.stringify(webState(this)));
});

Then("the web SPA does not show the create organization form", function (this: ChatticusWorld) {
	assert.notEqual(webState(this).view, "create-organization", JSON.stringify(webState(this)));
});

Given(
	"the operator created a pending organization {string} for {string}",
	async function (this: ChatticusWorld, name: string, email: string) {
		const store = this.messagingStore();
		const owner = await kernel.signIn(email, { store, clock: this.clock, ids: this.ids });
		const organization = await kernel.adminCreateOrganization(owner, name, { store, clock: this.clock, ids: this.ids });
		assert.equal(organization.status, "pending");
		this.orgsByName?.set(name, organization);
	},
);

Then("the web SPA does not ask for an AWS account", function (this: ChatticusWorld) {
	const text = visibleText(this).toLowerCase();
	for (const fragment of ["aws", "rolearn", "cloudformation", "cross-account"]) {
		assert.ok(!text.includes(fragment), JSON.stringify(webState(this)));
	}
});

Then("the web SPA does not show a queue position", function (this: ChatticusWorld) {
	const text = visibleText(this).toLowerCase();
	for (const fragment of ["queue", "position", "you are #", "you are number"]) {
		assert.ok(!text.includes(fragment), JSON.stringify(webState(this)));
	}
});

Then("the web SPA does not promise email notification", function (this: ChatticusWorld) {
	const text = visibleText(this).toLowerCase();
	for (const fragment of ["we will email", "we'll email", "email you when", "notify you by email"]) {
		assert.ok(!text.includes(fragment), JSON.stringify(webState(this)));
	}
});
