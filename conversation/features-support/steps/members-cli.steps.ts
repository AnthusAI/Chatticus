import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { SCENARIO_DEPLOYMENT_AWS_ACCOUNT_ID } from "../front-door.ts";
import {
	createOrganizationThroughCli,
	parseConfirmationLine,
	runMembersCliExpectingSuccess,
	runMembersCliProcess,
} from "../members-cli-process.ts";
import type { ChatticusWorld } from "../world.ts";

function organizationNamed(world: ChatticusWorld, name: string) {
	const organization = world.orgsByName?.get(name);
	assert.ok(organization, `No organization named ${JSON.stringify(name)} in this scenario.`);
	return organization;
}

/** Reload one organization from the store after the CLI changed it, so later steps see the stored state. */
async function refreshOrganization(world: ChatticusWorld, name: string, tenantId: string): Promise<void> {
	const stored = await world.messagingStore().getOrganization(tenantId);
	assert.ok(stored, `organization ${tenantId} is not in the store`);
	world.orgsByName?.set(name, stored);
}

When(
	"the members CLI lists organizations with status {string}",
	async function (this: ChatticusWorld, status: string) {
		await runMembersCliProcess(this, ["list", "--status", status]);
	},
);

for (const [verb, pastTense, expectedStatus] of [
	["enable", "enabled", "enabled"],
	["suspend", "suspended", "suspended"],
	["reinstate", "reinstated", "enabled"],
] as const) {
	When(
		`the members CLI ${verb}s organization {string} with confirmation`,
		async function (this: ChatticusWorld, name: string) {
			const organization = organizationNamed(this, name);
			const result = await runMembersCliExpectingSuccess(this, [verb, organization.tenantId, "--yes"]);
			const confirmation = parseConfirmationLine(result.stdout, pastTense);
			assert.equal(confirmation.tenant_id, organization.tenantId);
			assert.equal(confirmation.status, expectedStatus);
			await refreshOrganization(this, name, organization.tenantId);
		},
	);
}

When(
	"the members CLI creates organization {string} for {string} with confirmation",
	async function (this: ChatticusWorld, name: string, email: string) {
		await createOrganizationThroughCli(this, name, email);
	},
);

Then("the members CLI output includes organization {string}", function (this: ChatticusWorld, name: string) {
	const organization = organizationNamed(this, name);
	const result = this.membersCliResult;
	assert.ok(result, "the members CLI has not run in this scenario");
	assert.equal(result.exitCode, 0, result.stderr);
	const lines = result.stdout.split("\n").map((line) => line.split("\t"));
	const listed = lines.find((fields) => fields[0] === organization.tenantId);
	assert.ok(listed, `organization ${organization.tenantId} is not in the CLI output: ${JSON.stringify(result.stdout)}`);
	assert.equal(listed[1], organization.name);
});

Then("the members CLI output includes tenant {string}", function (this: ChatticusWorld, tenantId: string) {
	const result = this.membersCliResult;
	assert.ok(result, "the members CLI has not run in this scenario");
	assert.equal(result.exitCode, 0, result.stderr);
	const lines = result.stdout.split("\n").map((line) => line.split("\t"));
	assert.ok(
		lines.some((fields) => fields[0] === tenantId),
		`tenant ${tenantId} is not in the CLI output: ${JSON.stringify(result.stdout)}`,
	);
});

Given(
	"organization {string} already chose the customer-account setup path",
	async function (this: ChatticusWorld, name: string) {
		const organization = organizationNamed(this, name);
		await this.messagingStore().putOrganization({ ...organization, awsSetupPath: "customer-owned" });
	},
);

Given(
	"organization {string} is suspended with no AWS home and no setup path",
	async function (this: ChatticusWorld, name: string) {
		const organization = organizationNamed(this, name);
		await this.messagingStore().putOrganization({ ...organization, status: "suspended", awsAccountId: null, awsSetupPath: null });
	},
);

When("the members CLI enables organization {string} without checking the outcome", async function (this: ChatticusWorld, name: string) {
	await runMembersCliProcess(this, ["enable", organizationNamed(this, name).tenantId, "--yes"]);
});

Then("the members CLI refused the command", function (this: ChatticusWorld) {
	assert.ok(this.membersCliResult, "the members CLI has not run in this scenario");
	assert.notEqual(this.membersCliResult.exitCode, 0);
});

Then("organization {string} is homed in the deployment account as Anthus-managed", async function (this: ChatticusWorld, name: string) {
	const stored = await this.messagingStore().getOrganization(organizationNamed(this, name).tenantId);
	assert.equal(stored?.awsAccountId, SCENARIO_DEPLOYMENT_AWS_ACCOUNT_ID);
	assert.equal(stored?.awsSetupPath, "anthus-managed");
});

Then(
	"organization {string} keeps the setup path {string} and has no AWS account",
	async function (this: ChatticusWorld, name: string, setupPath: string) {
		const stored = await this.messagingStore().getOrganization(organizationNamed(this, name).tenantId);
		assert.equal(stored?.status, "enabled");
		assert.equal(stored?.awsSetupPath, setupPath);
		assert.equal(stored?.awsAccountId, null);
	},
);
