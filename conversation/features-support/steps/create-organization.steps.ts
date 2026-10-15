import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { OrganizationsKernelImpl } from "../../src/domain/organizations.ts";
import { recordResponse } from "../api.ts";
import { bearerFor, wireFrontDoor, wireOpenSignupFrontDoorForWebSpa } from "../front-door.ts";
import type { ChatticusWorld } from "../world.ts";

const kernel = new OrganizationsKernelImpl();

async function postOrganization(world: ChatticusWorld, email: string, name: string): Promise<void> {
	assert.ok(world.api);
	world.createOrganizationResponse = await recordResponse(
		await world.api.post("/organizations", { headers: await bearerFor(world, email), body: { name } }),
	);
	world.createdOrganizationName = name;
}

function createOrganizationResponse(world: ChatticusWorld) {
	assert.ok(world.createOrganizationResponse, "POST /organizations has not been called in this scenario");
	return world.createOrganizationResponse;
}

Given("a Cognito-verified HTTP front door with open signup", async function (this: ChatticusWorld) {
	await wireFrontDoor(this, { signupMode: "open", cognitoVerifier: true });
});

Given("a Cognito-verified HTTP front door with invitation-only signup", async function (this: ChatticusWorld) {
	await wireFrontDoor(this, { signupMode: "invitation_only", cognitoVerifier: true });
});

Given("a Cognito-verified HTTP front door with open signup wired to the web SPA", async function (this: ChatticusWorld) {
	await wireOpenSignupFrontDoorForWebSpa(this);
});

When(
	"POST \\/organizations is called with a valid id token for {string} and name {string}",
	async function (this: ChatticusWorld, email: string, name: string) {
		await postOrganization(this, email, name);
	},
);

Given(
	"{string} has created organization {string} via the HTTP front door",
	async function (this: ChatticusWorld, email: string, name: string) {
		await postOrganization(this, email, name);
		const response = createOrganizationResponse(this);
		assert.equal(response.status, 201, response.text);
		const organization = await this.messagingStore().getOrganization(response.json.tenant_id);
		assert.ok(organization);
		this.orgsByName?.set(name, organization);
		const identity = await kernel.signIn(email, {
			store: this.messagingStore(),
			clock: this.clock,
			ids: this.ids,
		});
		this.currentIdentity = identity;
		this.identitiesByEmail?.set(email, identity);
	},
);

Then("POST \\/organizations responds with status {int}", function (this: ChatticusWorld, status: number) {
	const response = createOrganizationResponse(this);
	assert.equal(response.status, status, response.text);
});

Then(
	"POST \\/organizations body includes tenant_id and status {string}",
	async function (this: ChatticusWorld, status: string) {
		const response = createOrganizationResponse(this);
		assert.equal(typeof response.json.tenant_id, "string");
		assert.ok(response.json.tenant_id.length > 0);
		assert.equal(response.json.status, status);
		const organization = await this.messagingStore().getOrganization(response.json.tenant_id);
		assert.ok(organization);
		assert.ok(this.createdOrganizationName);
		this.orgsByName?.set(this.createdOrganizationName, organization);
	},
);

Then(
	"{string} is an owner member of {string}",
	async function (this: ChatticusWorld, email: string, name: string) {
		const organization = this.orgsByName?.get(name);
		assert.ok(organization, `No organization named ${JSON.stringify(name)} in this scenario.`);
		const identity = await kernel.signIn(email, {
			store: this.messagingStore(),
			clock: this.clock,
			ids: this.ids,
		});
		this.identitiesByEmail?.set(email, identity);
		const membership = await this.messagingStore().getMembership(organization.tenantId, identity.userId);
		assert.ok(membership);
		assert.equal(membership.role, "owner");
	},
);
