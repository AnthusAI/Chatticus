import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { CognitoTokenError } from "../../src/auth/cognito.ts";
import { MembershipCache } from "../../src/auth/membership-cache.ts";
import {
	type CachedMembership,
	IdentityNotFoundError,
	type OrganizationStatus,
	PrincipalHttpError,
	resolvePrincipal,
	resolveUserPrincipalFromToken,
} from "../../src/auth/principal.ts";
import { FakePrincipalDirectory } from "../fakes/fake-principal-directory.ts";
import { CognitoTestKeys } from "../test-jwt.ts";
import type { ChatticusWorld } from "../world.ts";

async function seedOrganization(
	world: ChatticusWorld,
	tenantId: string,
	email: string,
	status: OrganizationStatus,
): Promise<void> {
	world.principalDirectory = new FakePrincipalDirectory();
	world.principalDirectory.seedOrganization(tenantId, email, status);
	world.cognitoTestKeys ??= await CognitoTestKeys.generate();
	world.resolverTenantId = tenantId;
	world.membershipCache = new MembershipCache<CachedMembership>({ nowMilliseconds: () => Date.now() });
}

async function resolveToken(world: ChatticusWorld, token: string): Promise<void> {
	world.resolverError = null;
	world.resolvedPrincipal = null;
	try {
		world.resolvedPrincipal = await resolveUserPrincipalFromToken(
			{
				verifier: (world.cognitoTestKeys as CognitoTestKeys).verifier(),
				directory: world.principalDirectory as FakePrincipalDirectory,
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
		const keys = this.cognitoTestKeys as CognitoTestKeys;
		await resolveToken(this, await keys.mintIdToken({ email }));
	},
);

When(
	"the Cognito resolver receives an expired id token for {string}",
	async function (this: ChatticusWorld, email: string) {
		const keys = this.cognitoTestKeys as CognitoTestKeys;
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
	const request = new Request("http://localhost/orgs/anthus/bots", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ user_id: "ryan", name: "Helper" }),
	});
	this.browserRouteStatus = null;
	try {
		await resolvePrincipal(request, {
			verifier: (this.cognitoTestKeys as CognitoTestKeys).verifier(),
			directory: this.principalDirectory as FakePrincipalDirectory,
			membershipCache: this.membershipCache as MembershipCache<CachedMembership>,
			requireEnabledMember: true,
		});
	} catch (error) {
		assert.ok(error instanceof PrincipalHttpError);
		this.browserRouteStatus = error.status;
	}
});

Then("the browser route responds with status {int}", function (this: ChatticusWorld, status: number) {
	assert.equal(this.browserRouteStatus, status);
});
