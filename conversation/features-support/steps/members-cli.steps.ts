import assert from "node:assert/strict";
import { Then, When } from "@cucumber/cucumber";
import { validateOrganizationName } from "../../src/domain/creation-limits.ts";
import { OrganizationsKernelImpl } from "../../src/domain/organizations.ts";
import type { OrganizationStatus } from "../../src/domain/organizations.ts";
import type { ChatticusWorld } from "../world.ts";

const kernel = new OrganizationsKernelImpl();

function organizationNamed(world: ChatticusWorld, name: string) {
	const organization = world.orgsByName?.get(name);
	assert.ok(organization, `No organization named ${JSON.stringify(name)} in this scenario.`);
	return organization;
}

When(
	"the members CLI lists organizations with status {string}",
	async function (this: ChatticusWorld, status: string) {
		this.membersCliListing = await kernel.listOrganizationsByStatus(status as OrganizationStatus, {
			store: this.messagingStore(),
		});
	},
);

When(
	"the members CLI enables organization {string} with confirmation",
	async function (this: ChatticusWorld, name: string) {
		const organization = organizationNamed(this, name);
		const enabled = await kernel.enableOrganization(organization.tenantId, { store: this.messagingStore() });
		this.orgsByName?.set(name, enabled);
	},
);

When(
	"the members CLI creates organization {string} for {string} with confirmation",
	async function (this: ChatticusWorld, name: string, email: string) {
		const store = this.messagingStore();
		const owner = await kernel.signIn(email, { store, clock: this.clock, ids: this.ids });
		this.identitiesByEmail?.set(email, owner);
		const organization = await kernel.adminCreateOrganization(owner, validateOrganizationName(name), {
			store,
			clock: this.clock,
			ids: this.ids,
		});
		this.orgsByName?.set(name, organization);
	},
);

Then("the members CLI output includes organization {string}", function (this: ChatticusWorld, name: string) {
	const organization = organizationNamed(this, name);
	assert.ok(this.membersCliListing, "the members CLI has not listed organizations in this scenario");
	const listed = this.membersCliListing.find((candidate) => candidate.tenantId === organization.tenantId);
	assert.ok(listed, `organization ${organization.tenantId} is not in the listing`);
	assert.equal(listed.name, organization.name);
});
