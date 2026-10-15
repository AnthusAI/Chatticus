import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { normalizeEmail } from "../../src/domain/organizations.ts";
import { createOrganizationThroughCli, parseConfirmationLine, runMembersCliExpectingSuccess } from "../members-cli-process.ts";
import type { ChatticusWorld } from "../world.ts";

const SEEDED_BOT_NAME = "Researcher";

Given(
	"a messaging store with tenant {string} user {string} bot data and no organization records",
	async function (this: ChatticusWorld, tenantId: string, _userId: string) {
		this.orgsByName = new Map();
		this.identitiesByEmail = new Map();
		this.currentIdentity = null;
		this.lastInvitation = null;
		this.lastError = null;
		const bot = { botId: this.ids.next(), tenantId, name: SEEDED_BOT_NAME, memory: {} };
		await this.messagingStore().putBot(bot, true);
		this.seededBotId = bot.botId;
	},
);

When(
	"the members CLI creates organization {string} for owner {string}",
	async function (this: ChatticusWorld, name: string, email: string) {
		await createOrganizationThroughCli(this, name, email);
	},
);

async function seedTenantThroughCli(world: ChatticusWorld, tenantId: string, email: string, name?: string) {
	const argv = ["seed", "--tenant-id", tenantId, "--owner-email", email, "--yes"];
	if (name !== undefined) {
		argv.push("--name", name);
	}
	const result = await runMembersCliExpectingSuccess(world, argv);
	const confirmation = parseConfirmationLine(result.stdout, "seeded");
	assert.equal(confirmation.tenant_id, tenantId);
	assert.equal(confirmation.status, "enabled");
	assert.equal(confirmation.email, normalizeEmail(email));
	const organization = await world.messagingStore().getOrganization(tenantId);
	assert.ok(organization, `tenant ${tenantId} is not in the store after seeding`);
	assert.equal(confirmation.owner, organization.ownerUserId);
	world.orgsByName?.set(organization.name, organization);
}

When(
	"the members CLI seeds tenant {string} for owner {string} with confirmation",
	async function (this: ChatticusWorld, tenantId: string, email: string) {
		await seedTenantThroughCli(this, tenantId, email);
	},
);

When(
	"the members CLI seeds tenant {string} for owner {string} with confirmation again",
	async function (this: ChatticusWorld, tenantId: string, email: string) {
		await seedTenantThroughCli(this, tenantId, email);
	},
);

When(
	"the members CLI seeds tenant {string} for owner {string} named {string} with confirmation",
	async function (this: ChatticusWorld, tenantId: string, email: string, name: string) {
		await seedTenantThroughCli(this, tenantId, email, name);
	},
);

Then(
	"organization tenant {string} has status {string}",
	async function (this: ChatticusWorld, tenantId: string, status: string) {
		const organization = await this.messagingStore().getOrganization(tenantId);
		assert.ok(organization, `tenant ${tenantId} is not in the store`);
		assert.equal(organization.status, status);
	},
);

Then(
	"organization tenant {string} has display name {string}",
	async function (this: ChatticusWorld, tenantId: string, name: string) {
		const organization = await this.messagingStore().getOrganization(tenantId);
		assert.ok(organization, `tenant ${tenantId} is not in the store`);
		assert.equal(organization.name, name);
	},
);

Then("the identity for {string} is keyed in lowercase", async function (this: ChatticusWorld, email: string) {
	const normalized = email.trim().toLowerCase();
	const identity = await this.messagingStore().getIdentityByEmail(normalized);
	assert.ok(identity, `no identity keyed by ${normalized}`);
	assert.equal(identity.email, normalized);
});

Then(
	"{string} is an owner member of tenant {string}",
	async function (this: ChatticusWorld, email: string, tenantId: string) {
		const store = this.messagingStore();
		const identity = await store.getIdentityByEmail(normalizeEmail(email));
		assert.ok(identity, `no identity for ${email}`);
		const membership = await store.getMembership(tenantId, identity.userId);
		assert.ok(membership, `${email} has no membership in ${tenantId}`);
		assert.equal(membership.role, "owner");
	},
);

Then(
	"{string} is not a member of tenant {string}",
	async function (this: ChatticusWorld, email: string, tenantId: string) {
		const store = this.messagingStore();
		const identity = await store.getIdentityByEmail(normalizeEmail(email));
		assert.ok(identity, `no identity for ${email}`);
		assert.equal(await store.getMembership(tenantId, identity.userId), null);
	},
);

Then(
	"tenant {string} user {string} bot data still exists",
	async function (this: ChatticusWorld, tenantId: string, _userId: string) {
		assert.ok(this.seededBotId, "no bot was seeded in this scenario");
		const bot = await this.messagingStore().getBot(tenantId, this.seededBotId);
		assert.ok(bot, `bot ${this.seededBotId} is gone from tenant ${tenantId}`);
		assert.equal(bot.name, SEEDED_BOT_NAME);
	},
);

Then("no computer exists for tenant {string}", async function (this: ChatticusWorld, tenantId: string) {
	assert.equal(await this.messagingStore().getComputer(tenantId), null);
});
