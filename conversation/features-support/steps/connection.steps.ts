import assert from "node:assert/strict";
import { Given, Then, When, type DataTable } from "@cucumber/cucumber";
import type { Organization } from "../../src/domain/organizations.ts";
import { OrganizationsKernelImpl } from "../../src/domain/organizations.ts";
import { ConnectionProposalStatus } from "../../src/policy/connections.ts";
import { policyControlFor, tableAsMap } from "../policy-control.ts";
import type { ChatticusWorld } from "../world.ts";

const kernel = new OrganizationsKernelImpl();

function organizationNamed(world: ChatticusWorld, name: string): Organization {
	const organization = world.orgsByName?.get(name);
	assert.ok(organization, `Unknown organization ${JSON.stringify(name)}.`);
	return organization;
}

function userIdOf(world: ChatticusWorld, email: string): string {
	const identity = world.identitiesByEmail?.get(email);
	assert.ok(identity, `Unknown member ${JSON.stringify(email)}.`);
	return identity.userId;
}

async function seedOrganizationWithMembers(
	world: ChatticusWorld,
	name: string,
	tenantId: string,
	table: DataTable,
): Promise<void> {
	const emails = table.rows().map((row) => row[0].trim());
	assert.ok(emails.length > 0, "Member table is empty.");
	const deps = { store: world.messagingStore(), clock: world.clock, ids: world.ids };
	const ownerEmail = emails[0];
	const organization = await kernel.adminSeedOrganization(tenantId, ownerEmail, name, deps);
	const owner = await kernel.signIn(ownerEmail, deps);
	world.orgsByName ??= new Map();
	world.identitiesByEmail ??= new Map();
	world.orgsByName.set(name, organization);
	world.identitiesByEmail.set(ownerEmail, owner);
	for (const email of emails.slice(1)) {
		const invitation = await kernel.inviteByEmail(tenantId, owner.userId, email, deps);
		const member = await kernel.signIn(email, deps);
		await kernel.acceptInvitation(invitation.invitationId, member, deps);
		world.identitiesByEmail.set(email, member);
	}
}

Given(
	"organization {string} with tenant {string} has enabled members:",
	async function (this: ChatticusWorld, name: string, tenantId: string, table: DataTable) {
		this.orgsByName = new Map();
		this.identitiesByEmail = new Map();
		this.sharedChannelsByName = new Map();
		await seedOrganizationWithMembers(this, name, tenantId, table);
	},
);

Given(
	"organization {string} with tenant {string} also has enabled members:",
	async function (this: ChatticusWorld, name: string, tenantId: string, table: DataTable) {
		await seedOrganizationWithMembers(this, name, tenantId, table);
	},
);

Given(
	"organization {string} has shared channel {string}",
	function (this: ChatticusWorld, organizationName: string, channelName: string) {
		const organization = organizationNamed(this, organizationName);
		this.sharedChannelsByName.set(channelName, {
			channelId: this.ids.next(),
			tenantId: organization.tenantId,
			name: channelName,
		});
	},
);

Given(
	"organization {string} member {string} has authority ceiling for structured {string} with:",
	async function (this: ChatticusWorld, organizationName: string, email: string, actionType: string, table: DataTable) {
		const organization = organizationNamed(this, organizationName);
		await policyControlFor(this).setMemberAuthorityCeiling(organization.tenantId, userIdOf(this, email), actionType, {
			arguments: tableAsMap(table),
		});
	},
);

async function proposeConnection(
	world: ChatticusWorld,
	options: {
		email: string;
		receivingOrganization: string;
		channelName: string;
		grantingOrganization: string;
		tryOnly: boolean;
	},
): Promise<void> {
	const granting = organizationNamed(world, options.grantingOrganization);
	const receiving = organizationNamed(world, options.receivingOrganization);
	const channel = world.sharedChannelsByName.get(options.channelName);
	assert.ok(channel, `Unknown shared channel ${JSON.stringify(options.channelName)}.`);
	const proposerUserId = userIdOf(world, options.email);
	const control = policyControlFor(world);
	const result = options.tryOnly
		? await control.tryProposeConnection(
				granting.tenantId,
				proposerUserId,
				receiving.tenantId,
				channel.channelId,
				options.channelName,
			)
		: await control.proposeConnection(
				granting.tenantId,
				proposerUserId,
				receiving.tenantId,
				channel.channelId,
				options.channelName,
			);
	world.lastConnectionResult = result;
	world.lastConnectionRoute = result.route;
}

When(
	"{string} proposes a connection for organization {string} to read shared channel {string} in organization {string}",
	async function (
		this: ChatticusWorld,
		email: string,
		receivingOrganization: string,
		channelName: string,
		grantingOrganization: string,
	) {
		await proposeConnection(this, { email, receivingOrganization, channelName, grantingOrganization, tryOnly: false });
	},
);

When(
	"{string} tries to propose a connection for organization {string} to read shared channel {string} in organization {string}",
	async function (
		this: ChatticusWorld,
		email: string,
		receivingOrganization: string,
		channelName: string,
		grantingOrganization: string,
	) {
		await proposeConnection(this, { email, receivingOrganization, channelName, grantingOrganization, tryOnly: true });
	},
);

When("the connection proposal is routed for approval", async function (this: ChatticusWorld) {
	const proposal = this.lastConnectionResult?.proposal;
	assert.ok(proposal, "no connection was proposed");
	this.lastConnectionRoute = await policyControlFor(this).routeConnectionProposal(
		proposal.grantingTenantId,
		proposal.proposalId,
	);
});

Then(
	"the connection is authorized and clipped to {string} ceiling",
	function (this: ChatticusWorld, email: string) {
		const result = this.lastConnectionResult;
		assert.ok(result, "no connection was proposed");
		assert.ok(result.authorized, "the connection was not authorized");
		assert.ok(result.route, "the connection has no route");
		assert.equal(result.route.status, ConnectionProposalStatus.Authorized);
		assert.equal(result.authorized.clippedByUserId, userIdOf(this, email));
		assert.ok(result.proposal);
		assert.equal(result.authorized.channelName, result.proposal.channelName);
		assert.equal(result.authorized.receivingTenantId, result.proposal.receivingTenantId);
	},
);

Then("proposing a connection outside the member authority ceiling is refused", async function (this: ChatticusWorld) {
	const result = this.lastConnectionResult;
	assert.ok(result, "no connection was proposed");
	assert.equal(result.refused, true);
	assert.equal(result.authorized, null);
	assert.ok(result.route, "the refused connection has no route");
	assert.equal(result.route.status, ConnectionProposalStatus.Refused);
	assert.ok(result.proposal);
	const refused = await policyControlFor(this).refusedConnections(result.proposal.grantingTenantId);
	assert.ok(refused.length > 0, "no refusal was recorded");
});

Then("the connection proposal escalates to {string}", function (this: ChatticusWorld, email: string) {
	const route = this.lastConnectionRoute;
	assert.ok(route, "the connection proposal has no route");
	assert.equal(route.status, ConnectionProposalStatus.PendingEscalation);
	assert.equal(route.escalationTargetUserId, userIdOf(this, email));
});

Then("no organization member ceiling covers the connection", function (this: ChatticusWorld) {
	const route = this.lastConnectionRoute;
	assert.ok(route, "the connection proposal has no route");
	assert.equal(route.status, ConnectionProposalStatus.Blocked);
	assert.equal(route.escalationTargetUserId, null);
});

Then(
	"the connection proposal stays blocked until a member with sufficient standing approves it",
	async function (this: ChatticusWorld) {
		const proposal = this.lastConnectionResult?.proposal;
		assert.ok(proposal, "no connection was proposed");
		assert.deepEqual(await policyControlFor(this).authorizedConnections(proposal.grantingTenantId), []);
	},
);
