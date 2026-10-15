import assert from "node:assert/strict";
import { Given, Then } from "@cucumber/cucumber";
import { MembershipCache } from "../../src/auth/membership-cache.ts";
import { type CachedMembership, type Principal, resolveUserPrincipalFromToken } from "../../src/auth/principal.ts";
import { StorePrincipalDirectory } from "../../src/auth/store-principal-directory.ts";
import { resolveWorkerPrincipalFromToken } from "../../src/auth/worker-principal.ts";
import { OrganizationsKernelImpl } from "../../src/domain/organizations.ts";
import { registerWorker } from "../../src/domain/workers.ts";
import { cognitoKeys } from "../front-door.ts";
import type { ChatticusWorld } from "../world.ts";

const kernel = new OrganizationsKernelImpl();
const userPrincipals = new WeakMap<ChatticusWorld, Principal>();

Given("a user principal for tenant {string}", async function (this: ChatticusWorld, tenantId: string) {
	const email = "member@example.com";
	const store = this.messagingStore();
	await kernel.adminSeedOrganization(tenantId, email, tenantId, { store, clock: this.clock, ids: this.ids });
	const keys = await cognitoKeys(this);
	userPrincipals.set(
		this,
		await resolveUserPrincipalFromToken(
			{
				verifier: keys.verifier(),
				directory: new StorePrincipalDirectory(store),
				membershipCache: new MembershipCache<CachedMembership>({ nowMilliseconds: () => Date.now() }),
				requireEnabledMember: true,
			},
			tenantId,
			await keys.mintIdToken({ email }),
		),
	);
});

Then("that principal has kind {string}", function (this: ChatticusWorld, kind: string) {
	const principal = userPrincipals.get(this);
	assert.ok(principal, "No user principal was resolved.");
	assert.equal(principal.kind, kind);
});

Then(
	"a worker principal for tenant {string} has kind {string}",
	async function (this: ChatticusWorld, tenantId: string, kind: string) {
		const store = this.messagingStore();
		const token = await registerWorker(
			{ workerId: "worker-1", tenantId, costClass: "local", capabilities: ["cpu"], computerId: null },
			{ store, clock: this.clock, ids: this.ids },
		);
		const principal = await resolveWorkerPrincipalFromToken(new StorePrincipalDirectory(store), tenantId, token);
		assert.equal(principal.kind, kind);
		assert.equal(principal.workerId, "worker-1");
	},
);
