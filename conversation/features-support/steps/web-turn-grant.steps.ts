import assert from "node:assert/strict";
import { Given, Then, When, type DataTable } from "@cucumber/cucumber";
import { PolicyControl } from "../../src/policy/policy-control.ts";
import { DynamoPolicyStore } from "../../src/store/policy-store.ts";
import { runMembershipUiHarness } from "../membership-ui-harness.ts";
import { grantReplacementEvents, grantTableOf } from "../turn-grant-support.ts";
import type { ChatticusWorld } from "../world.ts";
import { givenEnabledWorkspaceWebSpa } from "./bot.steps.ts";

function firstOrganization(world: ChatticusWorld) {
	const organization = [...(world.orgsByName?.values() ?? [])][0];
	assert.ok(organization, "The scenario has no organization");
	return organization;
}

function harnessPayload(world: ChatticusWorld): Record<string, string> {
	assert.ok(world.webApiBase && world.webIdToken, "web API base and id token must be wired for this scenario");
	return { api_base: world.webApiBase, id_token: world.webIdToken, tenant_id: firstOrganization(world).tenantId };
}

function harnessOf(world: ChatticusWorld): Record<string, any> {
	assert.ok(world.membershipUiHarness, "The web SPA harness has not run in this scenario.");
	return world.membershipUiHarness;
}

/** Point the scenario at the turn, channel and bot the web SPA harness started. */
function followHarnessTurn(world: ChatticusWorld): void {
	const harness = harnessOf(world);
	assert.ok(harness.activeTurnId, JSON.stringify(harness));
	world.lastTurnId = harness.activeTurnId;
	if (harness.workspaceChannelId) {
		world.lastChannel = { channelId: harness.workspaceChannelId, tenantId: firstOrganization(world).tenantId };
	}
}

Given(
	"the enabled workspace web SPA with an active turn for {string} in {string}",
	async function (this: ChatticusWorld, email: string, name: string) {
		await givenEnabledWorkspaceWebSpa(this, email, name);
		await runMembershipUiHarness(this, "setup-active-turn", harnessPayload(this));
		followHarnessTurn(this);
	},
);

Given("the signed-in member has a grant standing ceiling of:", async function (this: ChatticusWorld, table: DataTable) {
	assert.ok(this.currentIdentity, "No member is signed in");
	const policy = new PolicyControl({
		policyStore: new DynamoPolicyStore(this.messagingTable.client, this.messagingTable.tableName),
		store: this.messagingStore(),
		clock: this.clock,
		ids: this.ids,
	});
	await policy.setMemberGrantBoundsCeiling(firstOrganization(this).tenantId, this.currentIdentity.userId, {
		grantTable: grantTableOf(table),
	});
});

When("the web SPA replaces the active turn grant with:", async function (this: ChatticusWorld, table: DataTable) {
	await runMembershipUiHarness(this, "submit-turn-grant", { ...harnessPayload(this), ...grantTableOf(table) });
	this.lastGrantTable = harnessOf(this).lastGrantTable ?? null;
	followHarnessTurn(this);
});

When(
	"the web SPA replaces the active turn grant with run_terminal checked and:",
	async function (this: ChatticusWorld, table: DataTable) {
		await runMembershipUiHarness(this, "submit-turn-grant", {
			...harnessPayload(this),
			...grantTableOf(table),
			run_terminal: "true",
		});
		this.lastGrantTable = harnessOf(this).lastGrantTable ?? null;
		followHarnessTurn(this);
	},
);

When("the web SPA replaces the active turn grant with tools beyond that standing", async function (this: ChatticusWorld) {
	await runMembershipUiHarness(this, "submit-turn-grant-beyond-standing", harnessPayload(this));
	followHarnessTurn(this);
});

When("the web SPA tries to replace the active turn grant with an empty tool list", async function (this: ChatticusWorld) {
	await runMembershipUiHarness(this, "try-submit-empty-turn-grant", harnessPayload(this));
});

When(
	/^PUT \/turns\/\{turn_id\}\/grant is called with an empty tools list for the active turn$/,
	async function (this: ChatticusWorld) {
		await runMembershipUiHarness(this, "put-turn-grant-http", harnessPayload(this));
		followHarnessTurn(this);
	},
);

Then("the web SPA shows turn grant confirmation for {string}", function (this: ChatticusWorld, toolsCsv: string) {
	const tools = toolsCsv
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part !== "")
		.sort();
	assert.equal(harnessOf(this).turnGrantConfirmation, `Turn grant updated: ${tools.join(", ")}.`, JSON.stringify(harnessOf(this)));
});

Then("the web SPA shows a turn grant error", function (this: ChatticusWorld) {
	assert.ok(harnessOf(this).turnGrantError, JSON.stringify(harnessOf(this)));
});

Then("the web SPA did not call replace turn grant", function (this: ChatticusWorld) {
	assert.equal(harnessOf(this).turnGrantBlocked, true, JSON.stringify(harnessOf(this)));
	assert.equal(harnessOf(this).turnGrantConfirmation, null, JSON.stringify(harnessOf(this)));
});

Then("the web SPA does not show the turn grant form", function (this: ChatticusWorld) {
	assert.notEqual(harnessOf(this).turnGrantFormVisible, true, JSON.stringify(harnessOf(this)));
	assert.ok(!String(harnessOf(this).visibleText ?? "").includes("Authorize this turn"), JSON.stringify(harnessOf(this)));
});

Then(
	/^PUT \/turns\/\{turn_id\}\/grant responds with status (\d+)$/,
	function (this: ChatticusWorld, status: string) {
		assert.equal(harnessOf(this).turnGrantHttpStatus, Number(status), JSON.stringify(harnessOf(this)));
	},
);

Then("the turn journal records a grant replacement by the signed-in member", async function (this: ChatticusWorld) {
	assert.ok(this.currentIdentity, "No member is signed in");
	const replacements = await grantReplacementEvents(this);
	assert.ok(replacements.length > 0, "expected a turn.grant.replaced journal event");
	const body = JSON.parse(replacements.at(-1)!.body);
	assert.equal(body.actor_user_id, this.currentIdentity.userId);
	assert.ok(Array.isArray(body.tools));
});
