import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { CognitoTokenError } from "../../src/auth/cognito.ts";
import { MembershipCache } from "../../src/auth/membership-cache.ts";
import {
	type CachedMembership,
	IdentityNotFoundError,
	type OrganizationStatus,
	resolveUserPrincipalFromToken,
} from "../../src/auth/principal.ts";
import { StorePrincipalDirectory } from "../../src/auth/store-principal-directory.ts";
import { OrganizationsKernelImpl } from "../../src/domain/organizations.ts";
import { recordResponse } from "../api.ts";
import { cognitoKeys, wireFrontDoor } from "../front-door.ts";
import type { ChatticusWorld } from "../world.ts";

const kernel = new OrganizationsKernelImpl();

async function seedOrganization(
	world: ChatticusWorld,
	tenantId: string,
	email: string,
	status: OrganizationStatus,
): Promise<void> {
	const dependencies = { store: world.messagingStore(), clock: world.clock, ids: world.ids };
	await kernel.adminSeedOrganization(tenantId, email, tenantId, dependencies);
	if (status === "suspended") {
		await kernel.suspendOrganization(tenantId, dependencies);
	}
	await cognitoKeys(world);
	world.resolverTenantId = tenantId;
	world.membershipCache = new MembershipCache<CachedMembership>({ nowMilliseconds: () => Date.now() });
}

async function resolveToken(world: ChatticusWorld, token: string): Promise<void> {
	world.resolverError = null;
	world.resolvedPrincipal = null;
	try {
		world.resolvedPrincipal = await resolveUserPrincipalFromToken(
			{
				verifier: (await cognitoKeys(world)).verifier(),
				directory: new StorePrincipalDirectory(world.messagingStore()),
				membershipCache: world.membershipCache as MembershipCache<CachedMembership>,
				requireEnabledMember: true,
			},
			world.resolverTenantId,
			token,
		);
	} catch (error) {
		world.resolverError = error as Error;
	}
}

Given(
	"tenant {string} has an enabled organization for {string}",
	async function (this: ChatticusWorld, tenantId: string, email: string) {
		await seedOrganization(this, tenantId, email, "enabled");
	},
);

Given(
	"tenant {string} has a suspended organization for {string}",
	async function (this: ChatticusWorld, tenantId: string, email: string) {
		await seedOrganization(this, tenantId, email, "suspended");
	},
);

When(
	"the Cognito resolver receives a valid id token for {string}",
	async function (this: ChatticusWorld, email: string) {
		const keys = await cognitoKeys(this);
		await resolveToken(this, await keys.mintIdToken({ email }));
	},
);

When(
	"the Cognito resolver receives an expired id token for {string}",
	async function (this: ChatticusWorld, email: string) {
		const keys = await cognitoKeys(this);
		const expiredAtSeconds = Date.UTC(2020, 0, 1) / 1000;
		await resolveToken(this, await keys.mintIdToken({ email, expiresAtSeconds: expiredAtSeconds }));
	},
);

Then("the resolved principal has kind {string}", function (this: ChatticusWorld, kind: string) {
	assert.ok(this.resolvedPrincipal);
	assert.equal(this.resolvedPrincipal.kind, kind);
});

Then("the resolved principal belongs to tenant {string}", function (this: ChatticusWorld, tenantId: string) {
	assert.ok(this.resolvedPrincipal);
	assert.equal(this.resolvedPrincipal.tenantId, tenantId);
});

Then("the resolved principal has organization status {string}", function (this: ChatticusWorld, status: string) {
	assert.ok(this.resolvedPrincipal);
	assert.equal(this.resolvedPrincipal.organizationStatus, status);
});

Then("the resolved principal has role {string}", function (this: ChatticusWorld, role: string) {
	assert.ok(this.resolvedPrincipal);
	assert.equal(this.resolvedPrincipal.role, role);
});

Then("Cognito token resolution fails", function (this: ChatticusWorld) {
	assert.ok(this.resolverError instanceof CognitoTokenError);
});

Then("identity resolution fails for unknown email", function (this: ChatticusWorld) {
	assert.ok(this.resolverError instanceof IdentityNotFoundError);
});

When("a browser route is called without Authorization", async function (this: ChatticusWorld) {
	await wireFrontDoor(this, { signupMode: "invitation_only", cognitoVerifier: true });
	assert.ok(this.api, "The scenario has no HTTP front door.");
	const response = await recordResponse(
		await this.api.post("/orgs/anthus/bots", { body: { user_id: "ryan", name: "Helper" } }),
	);
	this.browserRouteStatus = response.status;
});

Then("the browser route responds with status {int}", function (this: ChatticusWorld, status: number) {
	assert.equal(this.browserRouteStatus, status);
});
