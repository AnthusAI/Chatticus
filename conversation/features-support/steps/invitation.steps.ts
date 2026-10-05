import assert from "node:assert/strict";
import { Given, When, Then } from "@cucumber/cucumber";
import type { ChatticusWorld } from "../world.ts";

When("the owner of {string} invites {string} via the HTTP front door", async function (
	this: ChatticusWorld,
	name: string,
	email: string,
) {
	const org = this.orgsByName?.get(name);
	assert.ok(org, `Organization ${JSON.stringify(name)} not found`);
	assert.ok(this.api, "API client not initialized");

	try {
		const response = await this.api.post(`/orgs/${org.tenantId}/invitations`, {
			body: { email },
		});
		this.lastHttpResponse = response;
	} catch (error) {
		this.lastHttpResponse = error as Response;
	}
});

When("a member of {string} tries to invite {string} via the HTTP front door", async function (
	this: ChatticusWorld,
	name: string,
	email: string,
) {
	const org = this.orgsByName?.get(name);
	assert.ok(org, `Organization ${JSON.stringify(name)} not found`);
	assert.ok(this.api, "API client not initialized");

	try {
		const response = await this.api.post(`/orgs/${org.tenantId}/invitations`, {
			body: { email },
		});
		this.lastHttpResponse = response;
	} catch (error) {
		this.lastHttpResponse = error as Response;
	}
});

Given("the invitation TTL has elapsed", async function (this: ChatticusWorld) {
	assert.ok(this.lastInvitation, "No invitation to expire");
	this.clock.advanceSeconds(8 * 24 * 60 * 60);
});

Then("POST \\/orgs\\/invitations responds with status {int}", async function (this: ChatticusWorld, status: number) {
	assert.ok(this.lastHttpResponse, "No HTTP response recorded");
	assert.equal(this.lastHttpResponse.status, status);
});

Then("GET \\/me does not include a pending organization", async function (this: ChatticusWorld) {
	assert.ok(this.lastHttpResponse, "No HTTP response recorded");
	const body = await this.lastHttpResponse.json();
	const pendingOrgs = body.organizations.filter((org: any) => org.status === "pending");
	assert.equal(pendingOrgs.length, 0);
});

Then("GET \\/me organizations include one with status {string}", async function (this: ChatticusWorld, status: string) {
	assert.ok(this.lastHttpResponse, "No HTTP response recorded");
	const body = await this.lastHttpResponse.json();
	const matchingOrgs = body.organizations.filter((org: any) => org.status === status);
	assert.ok(matchingOrgs.length > 0);
});

When("{string} is the current user on the me front door", async function (this: ChatticusWorld, email: string) {
	const identity = this.identitiesByEmail?.get(email);
	assert.ok(identity, `Identity for ${email} not found`);
	this.currentIdentity = identity;
});
