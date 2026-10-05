import assert from "node:assert/strict";
import { Then, When } from "@cucumber/cucumber";
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
