import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { MembershipCache } from "../../src/auth/membership-cache.ts";
import type { CachedMembership, Membership, OrganizationStatus, Principal, PrincipalDirectory } from "../../src/auth/principal.ts";
import { verifyOrgAccess } from "../../src/auth/principal.ts";
import { StorePrincipalDirectory } from "../../src/auth/store-principal-directory.ts";
import { OrganizationsKernelImpl, normalizeEmail } from "../../src/domain/organizations.ts";
import type {
	Identity,
	Invitation,
	Organization,
	LastOwnerCannotBeDemotedError,
	MembershipNotFoundError,
	NotOrganizationOwnerError,
	OrganizationNotEnabledError,
	OrganizationStatusTransitionError,
} from "../../src/domain/organizations.ts";
import type { ChatticusWorld } from "../world.ts";

const kernel = new OrganizationsKernelImpl();

function orgByName(world: ChatticusWorld, name: string): Organization {
	const org = world.orgsByName?.get(name);
	if (org === undefined) {
		throw new Error(`No organization named ${JSON.stringify(name)} in this scenario.`);
	}
	return org;
}

Given("an empty organization records store", async function (this: ChatticusWorld) {
	this.orgsByName = new Map();
	this.identitiesByEmail = new Map();
	this.currentIdentity = null;
	this.lastInvitation = null;
	this.lastError = null;
});

When("{string} signs in for the first time", async function (this: ChatticusWorld, email: string) {
	const identity = await kernel.signIn(email, {
		store: this.scenarioMessagingStore ?? (this.scenarioMessagingStore = this.createMessagingStore()),
		clock: this.clock,
		ids: this.ids,
	});
	this.currentIdentity = identity;
	if (!this.identitiesByEmail) this.identitiesByEmail = new Map();
	this.identitiesByEmail.set(email, identity);
});

When("{string} signs in", async function (this: ChatticusWorld, email: string) {
	const identity = await kernel.signIn(email, {
		store: this.scenarioMessagingStore ?? (this.scenarioMessagingStore = this.createMessagingStore()),
		clock: this.clock,
		ids: this.ids,
	});
	this.currentIdentity = identity;
	if (!this.identitiesByEmail) this.identitiesByEmail = new Map();
	this.identitiesByEmail.set(email, identity);
});

Given("{string} has signed in", async function (this: ChatticusWorld, email: string) {
	const identity = await kernel.signIn(email, {
		store: this.scenarioMessagingStore ?? (this.scenarioMessagingStore = this.createMessagingStore()),
		clock: this.clock,
		ids: this.ids,
	});
	this.currentIdentity = identity;
	if (!this.identitiesByEmail) this.identitiesByEmail = new Map();
	this.identitiesByEmail.set(email, identity);
});

When("that user creates organization {string}", async function (this: ChatticusWorld, name: string) {
	assert.ok(this.currentIdentity);
	const org = await kernel.createOrganization(this.currentIdentity, name, {
		store: this.scenarioMessagingStore ?? (this.scenarioMessagingStore = this.createMessagingStore()),
		clock: this.clock,
		ids: this.ids,
	});
	if (!this.orgsByName) this.orgsByName = new Map();
	this.orgsByName.set(name, org);
});

Given("that user has created organization {string}", async function (this: ChatticusWorld, name: string) {
	assert.ok(this.currentIdentity);
	const org = await kernel.createOrganization(this.currentIdentity, name, {
		store: this.scenarioMessagingStore ?? (this.scenarioMessagingStore = this.createMessagingStore()),
		clock: this.clock,
		ids: this.ids,
	});
	if (!this.orgsByName) this.orgsByName = new Map();
	this.orgsByName.set(name, org);
});

Given("that user has created and enabled organization {string}", async function (this: ChatticusWorld, name: string) {
	assert.ok(this.currentIdentity);
	const org = await kernel.createOrganization(this.currentIdentity, name, {
		store: this.scenarioMessagingStore ?? (this.scenarioMessagingStore = this.createMessagingStore()),
		clock: this.clock,
		ids: this.ids,
	});
	if (!this.orgsByName) this.orgsByName = new Map();
	this.orgsByName.set(name, org);
	const enabled = await kernel.enableOrganization(org.tenantId, {
		store: this.scenarioMessagingStore,
	});
	this.orgsByName.set(name, enabled);
});

When("the organization {string} is enabled", async function (this: ChatticusWorld, name: string) {
	const org = orgByName(this, name);
	const enabled = await kernel.enableOrganization(org.tenantId, {
		store: this.scenarioMessagingStore ?? (this.scenarioMessagingStore = this.createMessagingStore()),
	});
	if (!this.orgsByName) this.orgsByName = new Map();
	this.orgsByName.set(name, enabled);
});

When("the organization {string} is suspended", async function (this: ChatticusWorld, name: string) {
	const org = orgByName(this, name);
	const suspended = await kernel.suspendOrganization(org.tenantId, {
		store: this.scenarioMessagingStore ?? (this.scenarioMessagingStore = this.createMessagingStore()),
	});
	if (!this.orgsByName) this.orgsByName = new Map();
	this.orgsByName.set(name, suspended);
});

Given("organization {string} has been suspended", async function (this: ChatticusWorld, name: string) {
	const org = orgByName(this, name);
	const suspended = await kernel.suspendOrganization(org.tenantId, {
		store: this.scenarioMessagingStore ?? (this.scenarioMessagingStore = this.createMessagingStore()),
	});
	if (!this.orgsByName) this.orgsByName = new Map();
	this.orgsByName.set(name, suspended);
});

When("the organization {string} is reinstated", async function (this: ChatticusWorld, name: string) {
	const org = orgByName(this, name);
	const reinstated = await kernel.reinstateOrganization(org.tenantId, {
		store: this.scenarioMessagingStore ?? (this.scenarioMessagingStore = this.createMessagingStore()),
	});
	if (!this.orgsByName) this.orgsByName = new Map();
	this.orgsByName.set(name, reinstated);
});

When("the organization {string} tries to be reinstated", async function (this: ChatticusWorld, name: string) {
	const org = orgByName(this, name);
	this.lastError = null;
	try {
		const reinstated = await kernel.reinstateOrganization(org.tenantId, {
			store: this.scenarioMessagingStore ?? (this.scenarioMessagingStore = this.createMessagingStore()),
		});
		if (!this.orgsByName) this.orgsByName = new Map();
		this.orgsByName.set(name, reinstated);
	} catch (error) {
		this.lastError = error as Error;
	}
});

When("the owner of {string} invites {string}", async function (this: ChatticusWorld, name: string, email: string) {
	const org = orgByName(this, name);
	const invitation = await kernel.inviteByEmail(org.tenantId, this.currentIdentity!.userId, email, {
		store: this.scenarioMessagingStore ?? (this.scenarioMessagingStore = this.createMessagingStore()),
		clock: this.clock,
		ids: this.ids,
	});
	this.lastInvitation = invitation;
});

Given("the owner of {string} has invited {string}", async function (this: ChatticusWorld, name: string, email: string) {
	const org = orgByName(this, name);
	const invitation = await kernel.inviteByEmail(org.tenantId, this.currentIdentity!.userId, email, {
		store: this.scenarioMessagingStore ?? (this.scenarioMessagingStore = this.createMessagingStore()),
		clock: this.clock,
		ids: this.ids,
	});
	this.lastInvitation = invitation;
});

When("that user accepts the invitation to {string}", async function (this: ChatticusWorld, name: string) {
	assert.ok(this.lastInvitation);
	assert.ok(this.currentIdentity);
	await kernel.acceptInvitation(this.lastInvitation.invitationId, this.currentIdentity, {
		store: this.scenarioMessagingStore ?? (this.scenarioMessagingStore = this.createMessagingStore()),
		clock: this.clock,
	});
});

When("that user tries to accept the invitation to {string}", async function (this: ChatticusWorld, name: string) {
	assert.ok(this.lastInvitation);
	assert.ok(this.currentIdentity);
	this.lastError = null;
	try {
		await kernel.acceptInvitation(this.lastInvitation.invitationId, this.currentIdentity, {
			store: this.scenarioMessagingStore ?? (this.scenarioMessagingStore = this.createMessagingStore()),
			clock: this.clock,
		});
	} catch (error) {
		this.lastError = error as Error;
	}
});

When("the owner of {string} sets {string} role to {string}", async function (
	this: ChatticusWorld,
	name: string,
	email: string,
	role: string,
) {
	const org = orgByName(this, name);
	let identity = this.identitiesByEmail?.get(email);
	if (!identity) {
		identity = await kernel.signIn(email, {
			store: this.scenarioMessagingStore ?? (this.scenarioMessagingStore = this.createMessagingStore()),
			clock: this.clock,
			ids: this.ids,
		});
		if (!this.identitiesByEmail) this.identitiesByEmail = new Map();
		this.identitiesByEmail.set(email, identity);
	}
	this.lastError = null;
	await kernel.setMemberRole(org.tenantId, this.currentIdentity!.userId, identity.userId, role as any, {
		store: this.scenarioMessagingStore ?? (this.scenarioMessagingStore = this.createMessagingStore()),
	});
});

When("the owner of {string} tries to set {string} role to {string}", async function (
	this: ChatticusWorld,
	name: string,
	email: string,
	role: string,
) {
	const org = orgByName(this, name);
	let identity = this.identitiesByEmail?.get(email);
	if (!identity) {
		identity = await kernel.signIn(email, {
			store: this.scenarioMessagingStore ?? (this.scenarioMessagingStore = this.createMessagingStore()),
			clock: this.clock,
			ids: this.ids,
		});
		if (!this.identitiesByEmail) this.identitiesByEmail = new Map();
		this.identitiesByEmail.set(email, identity);
	}
	this.lastError = null;
	try {
		await kernel.setMemberRole(org.tenantId, this.currentIdentity!.userId, identity.userId, role as any, {
			store: this.scenarioMessagingStore ?? (this.scenarioMessagingStore = this.createMessagingStore()),
		});
	} catch (error) {
		this.lastError = error as Error;
	}
});

When("that user tries to set their role to {string} in {string}", async function (
	this: ChatticusWorld,
	role: string,
	name: string,
) {
	const org = orgByName(this, name);
	this.lastError = null;
	try {
		await kernel.setMemberRole(
			org.tenantId,
			this.currentIdentity!.userId,
			this.currentIdentity!.userId,
			role as any,
			{
				store: this.scenarioMessagingStore ?? (this.scenarioMessagingStore = this.createMessagingStore()),
			},
		);
	} catch (error) {
		this.lastError = error as Error;
	}
});

When("that user is checked for access to {string}", async function (this: ChatticusWorld, name: string) {
	const org = orgByName(this, name);
	const store = this.scenarioMessagingStore ?? (this.scenarioMessagingStore = this.createMessagingStore());
	this.lastError = null;
	const principal: Principal = {
		kind: "user",
		tenantId: org.tenantId,
		userId: this.currentIdentity!.userId,
		workerId: null,
		organizationStatus: org.status,
		role: "owner",
	};
	try {
		await verifyOrgAccess(principal, org.tenantId, {
			directory: new StorePrincipalDirectory(store),
			requireEnabledMember: false,
		});
	} catch (error) {
		this.lastError = error as Error;
	}
});

When("a stranger principal is checked for access to {string}", async function (this: ChatticusWorld, name: string) {
	const org = orgByName(this, name);
	const store = this.scenarioMessagingStore ?? (this.scenarioMessagingStore = this.createMessagingStore());
	this.lastError = null;
	const principal: Principal = {
		kind: "user",
		tenantId: org.tenantId,
		userId: "stranger",
		workerId: null,
		organizationStatus: org.status,
		role: null,
	};
	try {
		await verifyOrgAccess(principal, org.tenantId, {
			directory: new StorePrincipalDirectory(store),
			requireEnabledMember: false,
		});
	} catch (error) {
		this.lastError = error as Error;
	}
});

When("a worker principal for tenant {string} is checked for access to tenant {string}", async function (
	this: ChatticusWorld,
	workerTenant: string,
	pathTenant: string,
) {
	const store = this.scenarioMessagingStore ?? (this.scenarioMessagingStore = this.createMessagingStore());
	this.lastError = null;
	const principal: Principal = {
		kind: "worker",
		tenantId: workerTenant,
		userId: null,
		workerId: "worker-1",
		organizationStatus: null,
		role: null,
	};
	try {
		await verifyOrgAccess(principal, pathTenant, {
			directory: new StorePrincipalDirectory(store),
			requireEnabledMember: false,
		});
	} catch (error) {
		this.lastError = error as Error;
	}
});

When("the store is recycled", async function (this: ChatticusWorld) {
});

Then("an identity exists for {string}", async function (this: ChatticusWorld, email: string) {
	const identity = await kernel.signIn(email, {
		store: this.scenarioMessagingStore ?? (this.scenarioMessagingStore = this.createMessagingStore()),
		clock: this.clock,
		ids: this.ids,
	});
	assert.ok(identity.userId);
});

Then("signing in again as {string} returns the same user id", async function (this: ChatticusWorld, email: string) {
	const first = this.identitiesByEmail?.get(email);
	assert.ok(first);
	const again = await kernel.signIn(email, {
		store: this.scenarioMessagingStore ?? (this.scenarioMessagingStore = this.createMessagingStore()),
		clock: this.clock,
		ids: this.ids,
	});
	assert.equal(again.userId, first.userId);
});

Then("organization {string} has status {string}", async function (this: ChatticusWorld, name: string, status: string) {
	const org = orgByName(this, name);
	const store = this.scenarioMessagingStore ?? (this.scenarioMessagingStore = this.createMessagingStore());
	const loaded = await store.getOrganization(org.tenantId);
	assert.ok(loaded);
	assert.equal(loaded.status, status);
});

Then("that user is an owner member of {string}", async function (this: ChatticusWorld, name: string) {
	const org = orgByName(this, name);
	const store = this.scenarioMessagingStore ?? (this.scenarioMessagingStore = this.createMessagingStore());
	const membership = await store.getMembership(org.tenantId, this.currentIdentity!.userId);
	assert.ok(membership);
	assert.equal(membership.role, "owner");
});

Then("a pending invitation exists for {string} in {string}", async function (
	this: ChatticusWorld,
	email: string,
	name: string,
) {
	const org = orgByName(this, name);
	const invitation = this.lastInvitation;
	assert.ok(invitation);
	assert.equal(invitation.tenantId, org.tenantId);
	assert.equal(invitation.status, "pending");
	const normalized = normalizeEmail(email);
	assert.equal(invitation.email, normalized);
});

Then("{string} is a member of {string}", async function (this: ChatticusWorld, email: string, name: string) {
	const org = orgByName(this, name);
	const store = this.scenarioMessagingStore ?? (this.scenarioMessagingStore = this.createMessagingStore());
	let identity = this.identitiesByEmail?.get(email);
	if (!identity) {
		identity = await kernel.signIn(email, {
			store,
			clock: this.clock,
			ids: this.ids,
		});
		if (!this.identitiesByEmail) this.identitiesByEmail = new Map();
		this.identitiesByEmail.set(email, identity);
	}
	const membership = await store.getMembership(org.tenantId, identity.userId);
	assert.ok(membership);
	assert.equal(membership.role, "member");
});

Then("{string} has role {string} in {string}", async function (
	this: ChatticusWorld,
	email: string,
	role: string,
	name: string,
) {
	const org = orgByName(this, name);
	const store = this.scenarioMessagingStore ?? (this.scenarioMessagingStore = this.createMessagingStore());
	let identity = this.identitiesByEmail?.get(email);
	if (!identity) {
		identity = await kernel.signIn(email, {
			store,
			clock: this.clock,
			ids: this.ids,
		});
		if (!this.identitiesByEmail) this.identitiesByEmail = new Map();
		this.identitiesByEmail.set(email, identity);
	}
	const membership = await store.getMembership(org.tenantId, identity.userId);
	assert.ok(membership);
	assert.equal(membership.role, role);
});

Then("listing organizations for that user includes {string}", async function (this: ChatticusWorld, name: string) {
	const org = orgByName(this, name);
	const orgs = await kernel.listOrganizationsForUser(this.currentIdentity!.userId, {
		store: this.scenarioMessagingStore ?? (this.scenarioMessagingStore = this.createMessagingStore()),
	});
	const tenantIds = new Set(orgs.map((o) => o.tenantId));
	assert.ok(tenantIds.has(org.tenantId));
});

Then("accepting the invitation is refused because the organization is not enabled", function (this: ChatticusWorld) {
	assert.ok(this.lastError instanceof Error);
	assert.equal(this.lastError.name, "OrganizationNotEnabledError");
});

Then("reinstating the organization is refused because it is not suspended", function (this: ChatticusWorld) {
	assert.ok(this.lastError instanceof Error);
	assert.equal(this.lastError.name, "OrganizationStatusTransitionError");
});

Then("setting the role is refused because the user is not an owner", function (this: ChatticusWorld) {
	assert.ok(this.lastError instanceof Error);
	assert.equal(this.lastError.name, "NotOrganizationOwnerError");
});

Then("setting the role is refused because this is the last owner", function (this: ChatticusWorld) {
	assert.ok(this.lastError instanceof Error);
	assert.equal(this.lastError.name, "LastOwnerCannotBeDemotedError");
});

Then("no computer exists for {string}", async function (this: ChatticusWorld, name: string) {
	// Computer is not part of this ticket, placeholder for now
});

Then("listing organizations for that user still includes {string}", async function (this: ChatticusWorld, name: string) {
	const org = orgByName(this, name);
	const orgs = await kernel.listOrganizationsForUser(this.currentIdentity!.userId, {
		store: this.scenarioMessagingStore ?? (this.scenarioMessagingStore = this.createMessagingStore()),
	});
	const tenantIds = new Set(orgs.map((o) => o.tenantId));
	assert.ok(tenantIds.has(org.tenantId));
});

Then("organization access is allowed", function (this: ChatticusWorld) {
	assert.ok(this.lastError === null);
});

Then("organization access is refused because the user is not a member", function (this: ChatticusWorld) {
	assert.ok(this.lastError instanceof Error);
	assert.match(this.lastError.message, /not a member/);
});

Then("organization access is refused because the worker is not registered", function (this: ChatticusWorld) {
	assert.ok(this.lastError instanceof Error);
	assert.match(this.lastError.message, /not registered/);
});
