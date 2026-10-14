import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { OrganizationsKernelImpl } from "../../src/domain/organizations.ts";
import {
	homeEnabledOrganizationsWithoutAwsHome,
	type OrganizationAwsHomeMigration,
} from "../../src/migration/organization-aws-home.ts";
import { STORY_TENANT } from "../computer-scenario.ts";
import { InMemoryMessagingStore } from "../in-memory-messaging-store.ts";
import { ensureTestOrganization } from "../org-user-client.ts";
import { OWNER_START_DEPLOYMENT_ACCOUNT } from "../owner-start-support.ts";
import { SCENARIO_DEPLOYMENT_AWS_ACCOUNT_ID } from "../front-door.ts";
import type { ChatticusWorld } from "../world.ts";

const kernel = new OrganizationsKernelImpl();
const migrationsByWorld = new WeakMap<ChatticusWorld, OrganizationAwsHomeMigration[]>();

function organizationNamed(world: ChatticusWorld, name: string) {
	const organization = world.orgsByName?.get(name);
	assert.ok(organization, `No organization named ${JSON.stringify(name)} in this scenario.`);
	return organization;
}

async function storedOrganizationNamed(world: ChatticusWorld, name: string) {
	const stored = await world.messagingStore().getOrganization(organizationNamed(world, name).tenantId);
	assert.ok(stored, `Organization ${JSON.stringify(name)} is not in the store.`);
	return stored;
}

async function runMigration(world: ChatticusWorld, execute: boolean, tenantId?: string): Promise<void> {
	migrationsByWorld.set(
		world,
		await homeEnabledOrganizationsWithoutAwsHome(
			{ store: world.messagingStore() },
			{
				deploymentAwsAccountId: SCENARIO_DEPLOYMENT_AWS_ACCOUNT_ID,
				execute,
				...(tenantId === undefined ? {} : { tenantId }),
			},
		),
	);
}

Given("the organization was created in the app and then enabled by the operator", async function (this: ChatticusWorld) {
	await ensureTestOrganization(this, STORY_TENANT);
	const store = this.messagingStore();
	const seeded = await store.getOrganization(STORY_TENANT);
	assert.ok(seeded, "The story organization was not seeded.");
	const owner = await kernel.signIn("created-in-app@example.com", { store: new InMemoryMessagingStore(), clock: this.clock, ids: this.ids });
	const created = await kernel.createOrganization(owner, "Created In App", {
		store: new InMemoryMessagingStore(),
		clock: this.clock,
		ids: { next: () => STORY_TENANT },
	});
	await store.putOrganization({ ...created, ownerUserId: seeded.ownerUserId });
	await kernel.enableOrganization(STORY_TENANT, { store, callerAwsAccountId: async () => OWNER_START_DEPLOYMENT_ACCOUNT });
});

Given("organization {string} is enabled with no AWS home and no setup path", async function (this: ChatticusWorld, name: string) {
	await this.messagingStore().putOrganization({ ...organizationNamed(this, name), status: "enabled", awsAccountId: null, awsSetupPath: null });
});

Given(
	"organization {string} is enabled with no AWS home but the customer-account setup path",
	async function (this: ChatticusWorld, name: string) {
		await this.messagingStore().putOrganization({
			...organizationNamed(this, name),
			status: "enabled",
			awsAccountId: null,
			awsSetupPath: "customer-owned",
		});
	},
);

When("the organization AWS home migration runs as a dry run", async function (this: ChatticusWorld) {
	await runMigration(this, false);
});

When("the organization AWS home migration runs for real", async function (this: ChatticusWorld) {
	await runMigration(this, true);
});

When("the organization AWS home migration runs for real for organization {string}", async function (this: ChatticusWorld, name: string) {
	await runMigration(this, true, organizationNamed(this, name).tenantId);
});

Then("the migration reports {string} for organization {string}", function (this: ChatticusWorld, outcome: string, name: string) {
	const tenantId = organizationNamed(this, name).tenantId;
	const migration = (migrationsByWorld.get(this) ?? []).find((candidate) => candidate.tenantId === tenantId);
	assert.equal(migration?.outcome, outcome, JSON.stringify(migrationsByWorld.get(this)));
});

Then("the migration reports nothing to home", function (this: ChatticusWorld) {
	assert.deepEqual(migrationsByWorld.get(this), []);
});

Then("the migration does not mention organization {string}", function (this: ChatticusWorld, name: string) {
	const tenantId = organizationNamed(this, name).tenantId;
	assert.ok(!(migrationsByWorld.get(this) ?? []).some((candidate) => candidate.tenantId === tenantId), JSON.stringify(migrationsByWorld.get(this)));
});

Then("organization {string} has no AWS home and no setup path", async function (this: ChatticusWorld, name: string) {
	const stored = await storedOrganizationNamed(this, name);
	assert.equal(stored.awsAccountId, null);
	assert.equal(stored.awsSetupPath, null);
});

Then("organization {string} is still enabled", async function (this: ChatticusWorld, name: string) {
	assert.equal((await storedOrganizationNamed(this, name)).status, "enabled");
});
