import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { MISMATCHED_EXTERNAL_ID, configureCustomerRole } from "../customer-self-setup.ts";
import { runMembershipUiHarness } from "../membership-ui-harness.ts";
import type { ChatticusWorld } from "../world.ts";

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

Then("the web SPA shows the cross-account self-setup form", function (this: ChatticusWorld) {
	assert.ok(visibleText(this).includes("Submit AWS account and RoleArn"), JSON.stringify(webState(this)));
});

When("the web SPA submits cross-account self-setup via HTTP", async function (this: ChatticusWorld) {
	assert.ok(this.webApiBase, "web API base is not wired for this scenario");
	const payload: Record<string, string> = { api_base: this.webApiBase };
	if (this.webIdToken) {
		payload.id_token = this.webIdToken;
	}
	await runMembershipUiHarness(this, "submit-cross-account-self-setup", payload);
});

function createdTenantId(world: ChatticusWorld): string {
	const organizations = webState(world).me?.organizations ?? [];
	assert.ok(organizations.length > 0, JSON.stringify(webState(world)));
	return organizations[0].tenant_id;
}

When(
	"the in-memory role inspector trusts the created organization ExternalId with full permissions",
	function (this: ChatticusWorld) {
		configureCustomerRole(this, { trustedExternalId: createdTenantId(this) });
	},
);

When(
	"the in-memory role inspector trusts a mismatched ExternalId for the created organization",
	function (this: ChatticusWorld) {
		createdTenantId(this);
		configureCustomerRole(this, { trustedExternalId: MISMATCHED_EXTERNAL_ID });
	},
);

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

Then("the web SPA shows a cross-account self-setup error naming the ExternalId mismatch", function (this: ChatticusWorld) {
	const text = visibleText(this).toLowerCase();
	assert.ok(text.replaceAll(" ", "").includes("externalid"), JSON.stringify(webState(this)));
	assert.ok(text.includes("cloudformation"), JSON.stringify(webState(this)));
});
