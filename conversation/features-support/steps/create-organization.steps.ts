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

function organizationNamed(world: ChatticusWorld, name: string) {
	const organization = world.orgsByName?.get(name);
	assert.ok(organization, `No organization named ${JSON.stringify(name)} in this scenario.`);
	return organization;
}

async function identityOf(world: ChatticusWorld, email: string) {
	return kernel.signIn(email, { store: world.messagingStore(), clock: world.clock, ids: world.ids });
}

When(
	"{string} creates bot {string} in organization {string} via the HTTP front door",
	async function (this: ChatticusWorld, email: string, botName: string, organizationName: string) {
		assert.ok(this.api);
		this.createBotResponse = await recordResponse(
			await this.api.post(`/orgs/${organizationNamed(this, organizationName).tenantId}/bots`, {
				headers: await bearerFor(this, email),
				body: { name: botName },
			}),
		);
		this.createdBotIdsByName = this.createdBotIdsByName ?? new Map();
		if (this.createBotResponse.status === 200) {
			this.createdBotIdsByName.set(botName, this.createBotResponse.json.bot_id);
		}
	},
);

When(
	"{string} opens a direct channel with bot {string} in organization {string} via the HTTP front door",
	async function (this: ChatticusWorld, email: string, botName: string, organizationName: string) {
		assert.ok(this.api);
		const botId = this.createdBotIdsByName?.get(botName);
		assert.ok(botId, `Bot ${JSON.stringify(botName)} was not created in this scenario.`);
		const response = await recordResponse(
			await this.api.post(`/orgs/${organizationNamed(this, organizationName).tenantId}/channels`, {
				headers: await bearerFor(this, email),
				body: { user_id: (await identityOf(this, email)).userId, bot_ids: [botId], kind: "direct", name: null },
			}),
		);
		assert.equal(response.status, 200, response.text);
		this.createdChannelId = response.json.channel_id;
	},
);

When(
	"{string} sends {string} to bot {string} in organization {string} via the HTTP front door",
	async function (this: ChatticusWorld, email: string, body: string, botName: string, organizationName: string) {
		assert.ok(this.api);
		const botId = this.createdBotIdsByName?.get(botName);
		assert.ok(botId && this.createdChannelId, "The bot and its channel were not created in this scenario.");
		this.postMessageResponse = await recordResponse(
			await this.api.post(
				`/orgs/${organizationNamed(this, organizationName).tenantId}/channels/${this.createdChannelId}/messages`,
				{
					headers: await bearerFor(this, email),
					body: {
						author_kind: "human",
						author_id: (await identityOf(this, email)).userId,
						body,
						addressed_to_bot_id: botId,
					},
				},
			),
		);
	},
);

Then("the message post responds with status {int} and starts a turn", function (this: ChatticusWorld, status: number) {
	assert.ok(this.postMessageResponse, "No message was posted in this scenario.");
	assert.equal(this.postMessageResponse.status, status, this.postMessageResponse.text);
	assert.equal(typeof this.postMessageResponse.json.turn_id, "string", this.postMessageResponse.text);
});

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
