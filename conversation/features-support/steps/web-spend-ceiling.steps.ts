import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { Decimal } from "../../src/budget/decimal.ts";
import { setMonthlyAwsSpendCeiling } from "../../src/domain/organization-spend.ts";
import { OrganizationsKernelImpl } from "../../src/domain/organizations.ts";
import { DEFAULT_FRONT_DOOR_ENVIRONMENT } from "../front-door.ts";
import { runMembershipUiHarness } from "../membership-ui-harness.ts";
import { ORGANIZATION_NAME, rollUpToday } from "../spend-ceiling.ts";
import type { ChatticusWorld } from "../world.ts";
import { utcDayOf } from "../../src/budget/calendar.ts";

const kernel = new OrganizationsKernelImpl();
const SPEND_CEILING_FORM_TITLE = "Raise the monthly AWS spend ceiling";
const SPEND_CEILING_MEMBER_GUIDANCE =
	"An owner of this organization can raise the monthly AWS spend ceiling to resume computer work.";
const SPEND_ABOVE_CEILING_MARGIN_USD = 50;

function harnessState(world: ChatticusWorld): Record<string, any> {
	assert.ok(world.membershipUiHarness, "The web SPA harness has not run in this scenario.");
	return world.membershipUiHarness;
}

function visibleText(world: ChatticusWorld): string {
	return String(harnessState(world).visibleText ?? "");
}

function webHarnessPayload(world: ChatticusWorld): { api_base: string; id_token: string } {
	assert.ok(world.webApiBase && world.webIdToken, "web API base and id token must be wired for this scenario");
	return { api_base: world.webApiBase, id_token: world.webIdToken };
}

function webOrganization(world: ChatticusWorld) {
	const organization = world.orgsByName?.get(ORGANIZATION_NAME);
	assert.ok(organization, `No organization named ${JSON.stringify(ORGANIZATION_NAME)} in this scenario.`);
	return organization;
}

Given(
	"the organization has a monthly spend ceiling of {int} USD and month-to-date spend past it",
	async function (this: ChatticusWorld, ceiling: number) {
		const organization = webOrganization(this);
		this.budgetEnvironment = DEFAULT_FRONT_DOOR_ENVIRONMENT;
		assert.ok(this.currentIdentity, "No signed-in owner in this scenario.");
		await setMonthlyAwsSpendCeiling(organization.tenantId, this.currentIdentity.userId, Decimal.parse(String(ceiling)), {
			store: this.messagingStore(),
		});
		this.costExplorer.setDailyCost(
			this.budgetEnvironment,
			organization.tenantId,
			utcDayOf(this.clock.now()),
			Decimal.parse(String(ceiling + SPEND_ABOVE_CEILING_MARGIN_USD)),
		);
		await rollUpToday(this);
	},
);

Given("the web SPA shows {string} as paused for a member", async function (this: ChatticusWorld, name: string) {
	await runMembershipUiHarness(this, "reset", { signup_mode: "invitation_only" });
	await runMembershipUiHarness(this, "seed-session", { email: "member@example.com", id_token: "unused" });
	await runMembershipUiHarness(this, "set-me-enabled", { tenant_id: "acme", name, role: "member", paused: "true" });
});

When("the web SPA reloads membership", async function (this: ChatticusWorld) {
	await runMembershipUiHarness(this, "refresh-me-from-api", webHarnessPayload(this));
});

When("the web SPA raises the spend ceiling to {string}", async function (this: ChatticusWorld, amount: string) {
	await runMembershipUiHarness(this, "refresh-me-from-api", webHarnessPayload(this));
	await runMembershipUiHarness(this, "submit-spend-ceiling", { ...webHarnessPayload(this), amount });
});

Then("the web SPA offers to raise the spend ceiling", function (this: ChatticusWorld) {
	assert.ok(visibleText(this).includes(SPEND_CEILING_FORM_TITLE), JSON.stringify(harnessState(this)));
});

Then("the web SPA does not offer to raise the spend ceiling", function (this: ChatticusWorld) {
	assert.ok(!visibleText(this).includes(SPEND_CEILING_FORM_TITLE), JSON.stringify(harnessState(this)));
});

Then("the web SPA tells the member to ask an owner", function (this: ChatticusWorld) {
	assert.ok(visibleText(this).includes(SPEND_CEILING_MEMBER_GUIDANCE), JSON.stringify(harnessState(this)));
});

Then("the web SPA confirms the spend ceiling is now {int}", function (this: ChatticusWorld, amount: number) {
	const expected = `Monthly AWS spend ceiling is now $${amount}.`;
	const state = harnessState(this);
	assert.equal(state.spendCeilingError ?? null, null, JSON.stringify(state));
	assert.equal(state.spendCeilingConfirmation, expected, JSON.stringify(state));
	assert.ok(visibleText(this).includes(expected), JSON.stringify(state));
});

Then("the web SPA blocks the ceiling change before sending it", function (this: ChatticusWorld) {
	const state = harnessState(this);
	assert.equal(state.spendCeilingBlocked, true, JSON.stringify(state));
	assert.equal(state.spendCeilingConfirmation ?? null, null, JSON.stringify(state));
});

Then("the organization ceiling is {int} USD", async function (this: ChatticusWorld, amount: number) {
	const organization = await kernel.getOrganization(webOrganization(this).tenantId, { store: this.messagingStore() });
	const ceiling = organization.monthlyAwsSpendCeilingUsd;
	assert.ok(ceiling !== null && ceiling.equals(Decimal.parse(String(amount))), String(ceiling));
});

Then("the web SPA no longer shows computer work as paused", function (this: ChatticusWorld) {
	const state = harnessState(this);
	assert.equal(state.me.organizations[0].computer_work_paused, false, JSON.stringify(state.me.organizations));
	assert.ok(!visibleText(this).includes(SPEND_CEILING_FORM_TITLE), JSON.stringify(state));
});
