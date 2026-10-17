import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { Decimal } from "../../src/budget/decimal.ts";
import { OrganizationsKernelImpl } from "../../src/domain/organizations.ts";
import {
	giveOrganizationsWithoutSpendCeilingTheDefaultCeiling,
	type OrganizationSpendCeilingMigration,
} from "../../src/migration/organization-spend-ceiling.ts";
import type { ChatticusWorld } from "../world.ts";

const kernel = new OrganizationsKernelImpl();
const spendCeilingMigrationsByWorld = new WeakMap<ChatticusWorld, OrganizationSpendCeilingMigration[]>();

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

async function runSpendCeilingMigration(world: ChatticusWorld, execute: boolean, tenantId?: string): Promise<void> {
	spendCeilingMigrationsByWorld.set(
		world,
		await giveOrganizationsWithoutSpendCeilingTheDefaultCeiling(
			{ store: world.messagingStore() },
			{ execute, ...(tenantId === undefined ? {} : { tenantId }) },
		),
	);
}

function spendCeilingMigrationsReported(world: ChatticusWorld): OrganizationSpendCeilingMigration[] {
	return spendCeilingMigrationsByWorld.get(world) ?? [];
}

When("the operator seeds organization {string} for {string}", async function (this: ChatticusWorld, name: string, ownerEmail: string) {
	const organization = await kernel.adminSeedOrganization(this.ids.next(), ownerEmail, name, {
		store: this.messagingStore(),
		clock: this.clock,
		ids: this.ids,
	});
	if (!this.orgsByName) this.orgsByName = new Map();
	this.orgsByName.set(name, organization);
});

Given("organization {string} was created before the default ceiling and holds none", async function (this: ChatticusWorld, name: string) {
	await this.messagingStore().putOrganization({ ...organizationNamed(this, name), monthlyAwsSpendCeilingUsd: null });
});

Given("organization {string} is enabled with no monthly spend ceiling", async function (this: ChatticusWorld, name: string) {
	await this.messagingStore().putOrganization({ ...organizationNamed(this, name), status: "enabled", monthlyAwsSpendCeilingUsd: null });
});

Given("organization {string} is suspended with no monthly spend ceiling", async function (this: ChatticusWorld, name: string) {
	await this.messagingStore().putOrganization({ ...organizationNamed(this, name), status: "suspended", monthlyAwsSpendCeilingUsd: null });
});

Given(
	"organization {string} is enabled with a monthly spend ceiling of {word}",
	async function (this: ChatticusWorld, name: string, ceilingUsd: string) {
		await this.messagingStore().putOrganization({
			...organizationNamed(this, name),
			status: "enabled",
			monthlyAwsSpendCeilingUsd: Decimal.parse(ceilingUsd),
		});
	},
);

When("the organization spend ceiling migration runs as a dry run", async function (this: ChatticusWorld) {
	await runSpendCeilingMigration(this, false);
});

When("the organization spend ceiling migration runs for real", async function (this: ChatticusWorld) {
	await runSpendCeilingMigration(this, true);
});

When(
	"the organization spend ceiling migration runs for real for organization {string}",
	async function (this: ChatticusWorld, name: string) {
		await runSpendCeilingMigration(this, true, organizationNamed(this, name).tenantId);
	},
);

Then(
	"the spend ceiling migration reports {string} for organization {string}",
	function (this: ChatticusWorld, outcome: string, name: string) {
		const tenantId = organizationNamed(this, name).tenantId;
		const migration = spendCeilingMigrationsReported(this).find((candidate) => candidate.tenantId === tenantId);
		assert.equal(migration?.outcome, outcome, JSON.stringify(spendCeilingMigrationsReported(this)));
	},
);

Then("the spend ceiling migration reports nothing to change", function (this: ChatticusWorld) {
	assert.deepEqual(spendCeilingMigrationsReported(this), []);
});

Then("the spend ceiling migration does not mention organization {string}", function (this: ChatticusWorld, name: string) {
	const tenantId = organizationNamed(this, name).tenantId;
	assert.ok(
		!spendCeilingMigrationsReported(this).some((candidate) => candidate.tenantId === tenantId),
		JSON.stringify(spendCeilingMigrationsReported(this)),
	);
});

Then("organization {string} has a monthly spend ceiling of {word}", async function (this: ChatticusWorld, name: string, ceilingUsd: string) {
	const ceiling = (await storedOrganizationNamed(this, name)).monthlyAwsSpendCeilingUsd;
	assert.ok(ceiling !== null && ceiling.equals(Decimal.parse(ceilingUsd)), String(ceiling));
});

Then("organization {string} has no monthly spend ceiling", async function (this: ChatticusWorld, name: string) {
	assert.equal((await storedOrganizationNamed(this, name)).monthlyAwsSpendCeilingUsd, null);
});
