import assert from "node:assert/strict";
import { Given, Then, When, type DataTable } from "@cucumber/cucumber";
import { createBot } from "../../src/domain/bots.ts";
import { OrganizationsKernelImpl, normalizeEmail } from "../../src/domain/organizations.ts";
import { recordResponse } from "../api.ts";
import { cognitoKeys, wireFrontDoor, wireOpenSignupFrontDoorForWebSpa } from "../front-door.ts";
import { runMembershipUiHarness } from "../membership-ui-harness.ts";
import { seedEnabledWebSession } from "../web-session.ts";
import type { ChatticusWorld } from "../world.ts";

const kernel = new OrganizationsKernelImpl();
const CREATE_BOT_FORM_TITLE = "Create a bot";

async function resetScenarioToEmptyControlPlane(world: ChatticusWorld): Promise<void> {
	world.scenarioMessagingStore = world.createMessagingStore();
	await wireFrontDoor(world, { signupMode: "invitation_only", cognitoVerifier: true });
	world.botsById = new Map();
	world.botsByName = new Map();
	world.lastChannel = null;
	world.lastTurnId = null;
	world.messageError = null;
	world.directChannelPayloads = [];
	world.namedChannelPayload = null;
}

async function ensureMessagingUserMembership(world: ChatticusWorld, tenantId: string, userId: string): Promise<void> {
	const store = world.messagingStore();
	if ((await store.getOrganization(tenantId)) === null) {
		return;
	}
	if ((await store.getMembership(tenantId, userId)) !== null) {
		return;
	}
	const email = normalizeEmail(`${userId}@${tenantId}.test`);
	if ((await store.getIdentityByEmail(email)) === null) {
		await store.putIdentity({ userId, email, createdAt: world.clock.now() });
	}
	await store.putMembership({ tenantId, userId, role: "owner", joinedAt: world.clock.now() });
}

function harnessState(world: ChatticusWorld): Record<string, any> {
	assert.ok(world.membershipUiHarness, "The web SPA harness has not run in this scenario.");
	return world.membershipUiHarness;
}

function webHarnessPayload(world: ChatticusWorld): { api_base: string; id_token: string } {
	assert.ok(world.webApiBase && world.webIdToken, "web API base and id token must be wired for this scenario");
	return { api_base: world.webApiBase, id_token: world.webIdToken };
}

Given("an empty control plane", async function (this: ChatticusWorld) {
	await resetScenarioToEmptyControlPlane(this);
});

Given("an empty control plane backed by a durable messaging store with HTTP", async function (this: ChatticusWorld) {
	await resetScenarioToEmptyControlPlane(this);
});

Given(
	"tenant {string} user {string} has a bot named {string}",
	async function (this: ChatticusWorld, tenantId: string, userId: string, name: string) {
		await ensureMessagingUserMembership(this, tenantId, userId);
		const bot = await createBot(tenantId, name, { creatorUserId: userId }, { store: this.messagingStore(), ids: this.ids });
		this.botsById?.set(bot.botId, bot);
		this.botsByName?.set(name, bot);
	},
);

Given(
	"the enabled workspace web SPA for {string} in {string}",
	async function (this: ChatticusWorld, email: string, name: string) {
		await wireOpenSignupFrontDoorForWebSpa(this);
		const store = this.messagingStore();
		const identity = await kernel.signIn(email, { store, clock: this.clock, ids: this.ids });
		this.currentIdentity = identity;
		this.identitiesByEmail?.set(email, identity);
		const organization = await kernel.createOrganization(identity, name, { store, clock: this.clock, ids: this.ids });
		this.orgsByName?.set(name, organization);
		this.orgsByName?.set(name, await kernel.enableOrganization(organization.tenantId, { store }));
		await seedEnabledWebSession(this, email, name);
		const state = await runMembershipUiHarness(this, "render-shell");
		assert.equal(state.view, "enabled-workspace", JSON.stringify(state));
		assert.ok(String(state.visibleText ?? "").includes(CREATE_BOT_FORM_TITLE), JSON.stringify(state));
	},
);

When("the web SPA uses a signed-in session for {string}", async function (this: ChatticusWorld, email: string) {
	this.webIdToken = await (await cognitoKeys(this)).mintIdToken({ email });
	await runMembershipUiHarness(this, "seed-session", { email, id_token: this.webIdToken });
});

When("the web SPA creates bot {string}", async function (this: ChatticusWorld, name: string) {
	await runMembershipUiHarness(this, "submit-create-bot", { ...webHarnessPayload(this), name });
});

When("the web SPA tries to create a bot with an empty name", async function (this: ChatticusWorld) {
	await runMembershipUiHarness(this, "submit-create-bot", { ...webHarnessPayload(this), name: "   " });
});

Then("the web SPA shows create bot confirmation for {string}", function (this: ChatticusWorld, name: string) {
	assert.equal(harnessState(this).createBotConfirmation, `Created ${name}.`, JSON.stringify(harnessState(this)));
});

Then("the web SPA workspace roster shows:", function (this: ChatticusWorld, table: DataTable) {
	const expected = table
		.raw()
		.map((row) => (row[0] ?? "").trim())
		.filter((name) => name !== "");
	assert.deepEqual(harnessState(this).workspaceBotNames, expected, JSON.stringify(harnessState(this)));
});

Then("the web SPA workspace roster is empty", function (this: ChatticusWorld) {
	assert.deepEqual(harnessState(this).workspaceBotNames, [], JSON.stringify(harnessState(this)));
});

Then("the web SPA shows a create bot error", function (this: ChatticusWorld) {
	assert.ok(harnessState(this).createBotError, JSON.stringify(harnessState(this)));
});

Then("the web SPA did not call create bot", function (this: ChatticusWorld) {
	assert.equal(harnessState(this).createBotBlocked, true, JSON.stringify(harnessState(this)));
	assert.equal(harnessState(this).createBotConfirmation, null, JSON.stringify(harnessState(this)));
});

Then("the web SPA does not show the create bot form", function (this: ChatticusWorld) {
	const text: string = harnessState(this).visibleText ?? "";
	assert.ok(!text.includes(CREATE_BOT_FORM_TITLE), JSON.stringify(harnessState(this)));
});

When(
	"POST \\/bots is called with an empty name for organization {string}",
	async function (this: ChatticusWorld, name: string) {
		const organization = this.orgsByName?.get(name);
		assert.ok(organization, `No organization named ${JSON.stringify(name)} in this scenario.`);
		assert.ok(this.api && this.webIdToken);
		this.createBotResponse = await recordResponse(
			await this.api.post(`/orgs/${organization.tenantId}/bots`, {
				headers: { Authorization: `Bearer ${this.webIdToken}` },
				body: { name: "   " },
			}),
		);
	},
);

Then("POST \\/bots responds with status {int}", function (this: ChatticusWorld, status: number) {
	assert.ok(this.createBotResponse, "POST /bots has not been called in this scenario");
	assert.equal(this.createBotResponse.status, status, this.createBotResponse.text);
});
