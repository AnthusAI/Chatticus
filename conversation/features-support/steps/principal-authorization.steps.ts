import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { OrganizationsKernelImpl } from "../../src/domain/organizations.ts";
import { recordResponse, type RecordedResponse } from "../api.ts";
import { configureCustomerRole, selfSetupPayload } from "../customer-self-setup.ts";
import { bearerFor, wireFrontDoor } from "../front-door.ts";
import type { ChatticusWorld } from "../world.ts";

const kernel = new OrganizationsKernelImpl();
const responses = new WeakMap<ChatticusWorld, RecordedResponse>();
const ownerEmails = new WeakMap<ChatticusWorld, Map<string, string>>();

function rememberOwner(world: ChatticusWorld, tenantId: string, email: string): void {
	const emails = ownerEmails.get(world) ?? new Map<string, string>();
	emails.set(tenantId, email);
	ownerEmails.set(world, emails);
}

function api(world: ChatticusWorld) {
	assert.ok(world.api, "The scenario has no HTTP front door.");
	return world.api;
}

async function wirePrincipalFrontDoor(world: ChatticusWorld): Promise<void> {
	await wireFrontDoor(world, { signupMode: "invitation_only", cognitoVerifier: true, inMemoryRoleInspector: true });
}

async function record(world: ChatticusWorld, response: Response): Promise<void> {
	responses.set(world, await recordResponse(response));
}

Given(
	"principal enforcement has tenant {string} enabled for {string}",
	async function (this: ChatticusWorld, tenantId: string, email: string) {
		await kernel.adminSeedOrganization(tenantId, email, "Test Org", {
			store: this.messagingStore(),
			clock: this.clock,
			ids: this.ids,
		});
		rememberOwner(this, tenantId, email);
		await wirePrincipalFrontDoor(this);
	},
);

Given(
	"principal enforcement has tenant {string} pending for {string}",
	async function (this: ChatticusWorld, tenantId: string, email: string) {
		const store = this.messagingStore();
		const owner = await kernel.signIn(email, { store, clock: this.clock, ids: this.ids });
		const now = this.clock.now();
		await store.putOrganization({
			tenantId,
			name: tenantId,
			status: "pending",
			ownerUserId: owner.userId,
			createdAt: now,
			awsAccountId: null,
			awsCrossAccountRole: null,
			awsExternalId: null,
			awsSetupPath: null,
			setupFeeCents: null,
			assistedSetupSession: false,
			monthlyAwsSpendCeilingUsd: null,
		});
		await store.putMembership({ tenantId, userId: owner.userId, role: "owner", joinedAt: now });
		rememberOwner(this, tenantId, email);
		await wirePrincipalFrontDoor(this);
	},
);

Given(
	"the in-memory role inspector trusts tenant {string} ExternalId with full permissions",
	function (this: ChatticusWorld, tenantId: string) {
		configureCustomerRole(this, { trustedExternalId: tenantId });
	},
);

const ORG_USER_ROUTE_BODY = { user_id: "ryan", name: "Helper" };

When("an org user route is called without Authorization", async function (this: ChatticusWorld) {
	await record(this, await api(this).post("/orgs/anthus/bots", { body: ORG_USER_ROUTE_BODY }));
});

When(
	"an org user route is called for tenant {string} with Authorization",
	async function (this: ChatticusWorld, tenantId: string) {
		const email = ownerEmails.get(this)?.get(tenantId);
		assert.ok(email, `No owner is seeded for tenant ${tenantId}.`);
		await record(
			this,
			await api(this).post(`/orgs/${tenantId}/bots`, { headers: await bearerFor(this, email), body: ORG_USER_ROUTE_BODY }),
		);
	},
);

When(
	"an org user route is called for tenant {string} with a token for {string}",
	async function (this: ChatticusWorld, tenantId: string, email: string) {
		await record(
			this,
			await api(this).post(`/orgs/${tenantId}/bots`, { headers: await bearerFor(this, email), body: ORG_USER_ROUTE_BODY }),
		);
	},
);

When("GET \\/health is called", async function (this: ChatticusWorld) {
	await record(this, await api(this).get("/health"));
});

When("GET \\/auth\\/callback is called", async function (this: ChatticusWorld) {
	await record(this, await api(this).get("/auth/callback"));
});

When(
	"the owner submits cross-account self-setup for tenant {string} via HTTP",
	async function (this: ChatticusWorld, tenantId: string) {
		const email = ownerEmails.get(this)?.get(tenantId);
		assert.ok(email, `No owner is seeded for tenant ${tenantId}.`);
		await record(
			this,
			await api(this).post(`/orgs/${tenantId}/self-setup/cross-account-role`, {
				headers: await bearerFor(this, email),
				body: selfSetupPayload(),
			}),
		);
	},
);

Then("the principal response status is {int}", function (this: ChatticusWorld, status: number) {
	const response = responses.get(this);
	assert.ok(response, "No principal response was recorded.");
	assert.equal(response.status, status, response.text);
});
