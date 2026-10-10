import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { assumeOrganizationCrossAccountRole, submitSelfSetupCrossAccountRole } from "../../src/computer/provisioning.ts";
import { OrganizationsKernelImpl } from "../../src/domain/organizations.ts";
import { recordResponse } from "../api.ts";
import { provisionCrossAccountOrganization } from "../customer-computer.ts";
import {
	CUSTOMER_ACCOUNT_ID,
	CUSTOMER_ROLE_ARN,
	RecordingAssumeRole,
} from "../fakes/fake-customer-aws.ts";
import {
	MISMATCHED_EXTERNAL_ID,
	MISSING_PERMISSION,
	configureCustomerRole,
	createPendingOrganization,
	defaultMonthlyCeiling,
	permissionsWithoutTheMissingOne,
	selfSetupOrganization,
	selfSetupPayload,
	selfSetupScenario,
	storedOrganizationOf,
} from "../customer-self-setup.ts";
import { bearerFor, SCENARIO_DEPLOYMENT_AWS_ACCOUNT_ID, wireFrontDoor } from "../front-door.ts";
import { DEFAULT_OPERATOR_KEY } from "./operator.steps.ts";
import type { ChatticusWorld } from "../world.ts";
import { Decimal } from "../../src/budget/decimal.ts";

const kernel = new OrganizationsKernelImpl();
const PROVISIONING_SUBMITTED_CEILING = Decimal.parse("375.50");

function selfSetupPath(tenantId: string): string {
	return `/orgs/${tenantId}/self-setup/cross-account-role`;
}

function api(world: ChatticusWorld) {
	assert.ok(world.api, "The scenario has no HTTP front door.");
	return world.api;
}

async function postSelfSetup(world: ChatticusWorld, tenantId: string, headers: Record<string, string>): Promise<void> {
	selfSetupScenario(world).response = await recordResponse(
		await api(world).post(selfSetupPath(tenantId), { headers, body: selfSetupPayload() }),
	);
}

function selfSetupResponse(world: ChatticusWorld) {
	const response = selfSetupScenario(world).response;
	assert.ok(response, "No self-setup response was recorded.");
	return response;
}

function responseDetail(world: ChatticusWorld): string {
	const detail = selfSetupResponse(world).json?.detail;
	assert.equal(typeof detail, "string", selfSetupResponse(world).text);
	return detail;
}

function assertNamesExternalIdMismatch(message: string, tenantId: string): void {
	const lowered = message.toLowerCase();
	assert.ok(lowered.replaceAll(" ", "").includes("externalid"), message);
	assert.ok(message.includes(MISMATCHED_EXTERNAL_ID), message);
	assert.ok(message.includes(tenantId), message);
	assert.ok(lowered.includes("cloudformation"), message);
	assert.ok(lowered.replaceAll(" ", "").includes("organizationid"), message);
}

Given("a customer who has run the cross-account template in their own account", async function (this: ChatticusWorld) {
	const scenario = selfSetupScenario(this);
	scenario.organization = await createPendingOrganization(this, "owner@example.com", "Acme");
	scenario.ownerEmail = "owner@example.com";
	configureCustomerRole(this, { trustedExternalId: scenario.organization.tenantId });
});

Given("a customer whose role trusts a different ExternalId", async function (this: ChatticusWorld) {
	const scenario = selfSetupScenario(this);
	scenario.organization = await createPendingOrganization(this, "owner@example.com", "Acme");
	scenario.ownerEmail = "owner@example.com";
	configureCustomerRole(this, { trustedExternalId: MISMATCHED_EXTERNAL_ID });
});

Given("a customer whose role lacks a permission provisioning needs", async function (this: ChatticusWorld) {
	const scenario = selfSetupScenario(this);
	scenario.organization = await createPendingOrganization(this, "owner@example.com", "Acme");
	scenario.ownerEmail = "owner@example.com";
	configureCustomerRole(this, {
		trustedExternalId: scenario.organization.tenantId,
		grantedPermissions: permissionsWithoutTheMissingOne(),
	});
});

When("they submit their AWS account id and role", async function (this: ChatticusWorld) {
	const scenario = selfSetupScenario(this);
	const organization = selfSetupOrganization(this);
	scenario.directResult = await submitSelfSetupCrossAccountRole(
		organization.tenantId,
		{
			actorUserId: organization.ownerUserId,
			accountId: CUSTOMER_ACCOUNT_ID,
			crossAccountRole: CUSTOMER_ROLE_ARN,
			roleInspector: this.roleInspector,
			monthlyAwsSpendCeilingUsd: defaultMonthlyCeiling(),
		},
		{ store: this.messagingStore() },
	);
});

Then("provisioning proceeds without an assisted session", async function (this: ChatticusWorld) {
	const result = selfSetupScenario(this).directResult;
	assert.ok(result, "No self-setup submission was made.");
	assert.equal(result.accepted, true, String(result.message));
	const stored = await storedOrganizationOf(this, selfSetupOrganization(this).tenantId);
	assert.equal(stored.status, "enabled");
	assert.equal(stored.awsSetupPath, "customer-owned");
	assert.equal(stored.assistedSetupSession, false);
});

Then("no setup fee is charged", async function (this: ChatticusWorld) {
	const stored = await storedOrganizationOf(this, selfSetupOrganization(this).tenantId);
	assert.equal(stored.setupFeeCents, 0);
});

Then("the response names the ExternalId mismatch and how to correct it", function (this: ChatticusWorld) {
	const result = selfSetupScenario(this).directResult;
	assert.ok(result, "No self-setup submission was made.");
	assert.equal(result.accepted, false);
	assertNamesExternalIdMismatch(result.message ?? "", selfSetupOrganization(this).tenantId);
});

Then("the response names the missing permission", function (this: ChatticusWorld) {
	const result = selfSetupScenario(this).directResult;
	assert.ok(result, "No self-setup submission was made.");
	assert.equal(result.accepted, false);
	assert.ok((result.message ?? "").includes(MISSING_PERMISSION), result.message ?? "");
});

Then("the organization stays pending", async function (this: ChatticusWorld) {
	const stored = await storedOrganizationOf(this, selfSetupOrganization(this).tenantId);
	assert.equal(stored.status, "pending");
	assert.equal(stored.awsAccountId, null);
	assert.equal(stored.awsCrossAccountRole, null);
});

Given("an organization that has completed provisioning", async function (this: ChatticusWorld) {
	const organization = await createPendingOrganization(this, "owner@example.com", "Test Org");
	configureCustomerRole(this, { trustedExternalId: organization.tenantId });
	const result = await submitSelfSetupCrossAccountRole(
		organization.tenantId,
		{
			actorUserId: organization.ownerUserId,
			accountId: CUSTOMER_ACCOUNT_ID,
			crossAccountRole: CUSTOMER_ROLE_ARN,
			roleInspector: this.roleInspector,
			monthlyAwsSpendCeilingUsd: defaultMonthlyCeiling(),
		},
		{ store: this.messagingStore() },
	);
	assert.equal(result.accepted, true, String(result.message));
	selfSetupScenario(this).provisionedOrganization = organization;
});

Then("it records the customer AWS account id", async function (this: ChatticusWorld) {
	const provisioned = selfSetupScenario(this).provisionedOrganization;
	assert.ok(provisioned);
	assert.equal((await storedOrganizationOf(this, provisioned.tenantId)).awsAccountId, CUSTOMER_ACCOUNT_ID);
});

Then("it records the cross-account role", async function (this: ChatticusWorld) {
	const provisioned = selfSetupScenario(this).provisionedOrganization;
	assert.ok(provisioned);
	const stored = await storedOrganizationOf(this, provisioned.tenantId);
	assert.equal(stored.awsCrossAccountRole, CUSTOMER_ROLE_ARN);
	assert.equal(stored.awsExternalId, stored.tenantId);
});

Then("it records whether the account is customer-owned or Anthus-managed", async function (this: ChatticusWorld) {
	const provisioned = selfSetupScenario(this).provisionedOrganization;
	assert.ok(provisioned);
	assert.equal((await storedOrganizationOf(this, provisioned.tenantId)).awsSetupPath, "customer-owned");
});

Given("an organization that has paid but not been provisioned", async function (this: ChatticusWorld) {
	selfSetupScenario(this).pendingOrganization = await createPendingOrganization(this, "newowner@example.com", "Pending Org");
});

Then("it records no customer AWS account", async function (this: ChatticusWorld) {
	const pending = selfSetupScenario(this).pendingOrganization;
	assert.ok(pending);
	const stored = await storedOrganizationOf(this, pending.tenantId);
	assert.equal(stored.awsAccountId, null);
	assert.equal(stored.awsCrossAccountRole, null);
	assert.equal(stored.awsExternalId, null);
	assert.equal(stored.awsSetupPath, null);
});

Then("its status is pending", async function (this: ChatticusWorld) {
	const pending = selfSetupScenario(this).pendingOrganization;
	assert.ok(pending);
	assert.equal((await storedOrganizationOf(this, pending.tenantId)).status, "pending");
});

Given("an organization with a provisioned cross-account role", async function (this: ChatticusWorld) {
	const scenario = selfSetupScenario(this);
	scenario.assumeOrganization = await provisionCrossAccountOrganization(this, {
		name: "Provisioned Org",
		ownerEmail: "assume-owner@example.com",
		accountId: "111111111111",
		externalId: "external-id-alpha",
	});
	scenario.assumeRole = new RecordingAssumeRole();
});

Given("two organizations with cross-account roles in different AWS accounts", async function (this: ChatticusWorld) {
	const scenario = selfSetupScenario(this);
	scenario.firstOrganization = await provisionCrossAccountOrganization(this, {
		name: "First Org",
		ownerEmail: "first@example.com",
		accountId: "111111111111",
		externalId: "external-id-alpha",
	});
	scenario.secondOrganization = await provisionCrossAccountOrganization(this, {
		name: "Second Org",
		ownerEmail: "second@example.com",
		accountId: "222222222222",
		externalId: "external-id-beta",
	});
	scenario.assumeRole = new RecordingAssumeRole();
});

When("Chatticus assumes that role", async function (this: ChatticusWorld) {
	const scenario = selfSetupScenario(this);
	assert.ok(scenario.assumeOrganization);
	scenario.assumeOutcome = await assumeOrganizationCrossAccountRole(
		scenario.assumeOrganization.tenantId,
		{ assumeRole: scenario.assumeRole.port },
		{ store: this.messagingStore() },
	);
});

When(
	"Chatticus attempts the first organization role using the second organization ExternalId",
	async function (this: ChatticusWorld) {
		const scenario = selfSetupScenario(this);
		assert.ok(scenario.firstOrganization && scenario.secondOrganization);
		scenario.assumeOutcome = await assumeOrganizationCrossAccountRole(
			scenario.firstOrganization.tenantId,
			{ externalId: scenario.secondOrganization.awsExternalId, assumeRole: scenario.assumeRole.port },
			{ store: this.messagingStore() },
		);
	},
);

Then("the request carries the ExternalId recorded for that organization", function (this: ChatticusWorld) {
	const scenario = selfSetupScenario(this);
	const organization = scenario.assumeOrganization;
	assert.ok(organization);
	assert.equal(scenario.assumeRole.calls.length, 1);
	assert.equal(scenario.assumeRole.calls[0]?.ExternalId, organization.awsExternalId);
	assert.equal(scenario.assumeRole.calls[0]?.RoleArn, organization.awsCrossAccountRole);
	assert.equal(scenario.assumeOutcome?.refused, false);
	assert.equal(scenario.assumeOutcome?.externalId, organization.awsExternalId);
	assert.notEqual(scenario.assumeOutcome?.session, null);
});

Then("the assume is refused", function (this: ChatticusWorld) {
	assert.equal(selfSetupScenario(this).assumeOutcome?.refused, true);
});

Then("no session is issued", function (this: ChatticusWorld) {
	const scenario = selfSetupScenario(this);
	assert.equal(scenario.assumeOutcome?.session, null);
	assert.equal(scenario.assumeRole.calls.length, 0);
});

Given("an organization being provisioned into a customer AWS account", async function (this: ChatticusWorld) {
	const scenario = selfSetupScenario(this);
	scenario.organization = await createPendingOrganization(this, "owner@example.com", "Acme Labs");
	scenario.ownerEmail = "owner@example.com";
	configureCustomerRole(this, { trustedExternalId: scenario.organization.tenantId });
});

When("provisioning completes", async function (this: ChatticusWorld) {
	const scenario = selfSetupScenario(this);
	const organization = selfSetupOrganization(this);
	const result = await submitSelfSetupCrossAccountRole(
		organization.tenantId,
		{
			actorUserId: organization.ownerUserId,
			accountId: CUSTOMER_ACCOUNT_ID,
			crossAccountRole: CUSTOMER_ROLE_ARN,
			roleInspector: this.roleInspector,
			monthlyAwsSpendCeilingUsd: PROVISIONING_SUBMITTED_CEILING,
		},
		{ store: this.messagingStore() },
	);
	assert.equal(result.accepted, true, String(result.message));
	scenario.directResult = result;
});

Then("the organization carries a monthly AWS spend ceiling", async function (this: ChatticusWorld) {
	const stored = await storedOrganizationOf(this, selfSetupOrganization(this).tenantId);
	assert.ok(stored.monthlyAwsSpendCeilingUsd?.equals(PROVISIONING_SUBMITTED_CEILING), String(stored.monthlyAwsSpendCeilingUsd));
	assert.equal(stored.status, "enabled");
	assert.equal(stored.awsAccountId, CUSTOMER_ACCOUNT_ID);
	assert.equal(stored.awsCrossAccountRole, CUSTOMER_ROLE_ARN);
});

Given(
	"the customer self-setup HTTP front door is wired with an in-memory role inspector",
	async function (this: ChatticusWorld) {
		const previous = this.frontDoorOptions;
		await wireFrontDoor(this, {
			signupMode: "open",
			cognitoVerifier: true,
			...previous,
			operatorKey: DEFAULT_OPERATOR_KEY,
			inMemoryRoleInspector: true,
		});
		if (this.httpServer !== null) {
			this.webApiBase = this.httpServer.baseUrl;
		}
		this.operatorScenario = {
			organization: null,
			configuredOperatorKey: DEFAULT_OPERATOR_KEY,
			operatorBearerToken: null,
			requestHeaders: {},
			ownerEmail: "owner@example.com",
			workerId: null,
			response: null,
		};
	},
);

Given("a pending organization owned by {string}", async function (this: ChatticusWorld, email: string) {
	const scenario = selfSetupScenario(this);
	const name = email === "owner@example.com" ? "Acme Labs" : "Other Labs";
	const organization = await createPendingOrganization(this, email, name);
	if (scenario.organization === null) {
		scenario.organization = organization;
		scenario.ownerEmail = email;
	} else {
		scenario.otherOrganization = organization;
	}
});

Given(
	"the in-memory role inspector trusts the organization ExternalId with full permissions",
	function (this: ChatticusWorld) {
		configureCustomerRole(this, { trustedExternalId: selfSetupOrganization(this).tenantId });
	},
);

Given(
	"the in-memory role inspector trusts a mismatched ExternalId with full permissions",
	function (this: ChatticusWorld) {
		configureCustomerRole(this, { trustedExternalId: MISMATCHED_EXTERNAL_ID });
	},
);

Given(
	"the in-memory role inspector trusts the organization ExternalId without full permissions",
	function (this: ChatticusWorld) {
		configureCustomerRole(this, {
			trustedExternalId: selfSetupOrganization(this).tenantId,
			grantedPermissions: permissionsWithoutTheMissingOne(),
		});
	},
);

Given("{string} is a non-owner member of that organization", async function (this: ChatticusWorld, email: string) {
	const organization = selfSetupOrganization(this);
	const member = await kernel.signIn(email, { store: this.messagingStore(), clock: this.clock, ids: this.ids });
	await this.messagingStore().putMembership({
		tenantId: organization.tenantId,
		userId: member.userId,
		role: "member",
		joinedAt: this.clock.now(),
	});
	this.identitiesByEmail?.set(email, member);
});

When("the owner submits their AWS account id and RoleArn via HTTP", async function (this: ChatticusWorld) {
	const scenario = selfSetupScenario(this);
	assert.ok(scenario.ownerEmail);
	await postSelfSetup(this, selfSetupOrganization(this).tenantId, await bearerFor(this, scenario.ownerEmail));
});

When("{string} submits the AWS account id and RoleArn via HTTP", async function (this: ChatticusWorld, email: string) {
	await postSelfSetup(this, selfSetupOrganization(this).tenantId, await bearerFor(this, email));
});

When(
	"{string} submits the AWS account id and RoleArn for the other organization via HTTP",
	async function (this: ChatticusWorld, email: string) {
		const other = selfSetupScenario(this).otherOrganization;
		assert.ok(other, "No second pending organization is set.");
		await postSelfSetup(this, other.tenantId, await bearerFor(this, email));
	},
);

When("the self-setup endpoint is called without Authorization", async function (this: ChatticusWorld) {
	await postSelfSetup(this, selfSetupOrganization(this).tenantId, {});
});

When("the operator submits the AWS account id and RoleArn via HTTP", async function (this: ChatticusWorld) {
	const token = this.operatorScenario?.operatorBearerToken;
	assert.ok(token, "No operator credential is presented in this scenario.");
	await postSelfSetup(this, selfSetupOrganization(this).tenantId, { Authorization: `Bearer ${token}` });
});

When("the operator calls the enable endpoint for that pending organization", async function (this: ChatticusWorld) {
	const state = this.operatorScenario;
	assert.ok(state?.operatorBearerToken, "No operator credential is presented in this scenario.");
	const organization = selfSetupOrganization(this);
	state.organization = organization;
	state.response = await recordResponse(
		await api(this).post(`/operator/orgs/${organization.tenantId}/enable`, {
			headers: { Authorization: `Bearer ${state.operatorBearerToken}` },
		}),
	);
});

Then("the self-setup response status is {int}", function (this: ChatticusWorld, status: number) {
	assert.equal(selfSetupResponse(this).status, status, selfSetupResponse(this).text);
});

Then("the self-setup response accepts the submission", function (this: ChatticusWorld) {
	assert.equal(selfSetupResponse(this).json?.accepted, true, selfSetupResponse(this).text);
});

Then("that organization is enabled with AWS home recorded", async function (this: ChatticusWorld) {
	const organization = selfSetupOrganization(this);
	const stored = await storedOrganizationOf(this, organization.tenantId);
	assert.equal(stored.status, "enabled");
	assert.equal(stored.awsAccountId, CUSTOMER_ACCOUNT_ID);
	assert.equal(stored.awsCrossAccountRole, CUSTOMER_ROLE_ARN);
	assert.equal(stored.awsExternalId, organization.tenantId);
});

Then("that organization stays pending with no AWS home", async function (this: ChatticusWorld) {
	const stored = await storedOrganizationOf(this, selfSetupOrganization(this).tenantId);
	assert.equal(stored.status, "pending");
	assert.equal(stored.awsAccountId, null);
	assert.equal(stored.awsCrossAccountRole, null);
});

Then("the self-setup response names the ExternalId mismatch and how to correct it", function (this: ChatticusWorld) {
	assertNamesExternalIdMismatch(responseDetail(this), selfSetupOrganization(this).tenantId);
});

Then("the self-setup response names the missing permission", function (this: ChatticusWorld) {
	assert.ok(responseDetail(this).includes(MISSING_PERMISSION), responseDetail(this));
});

Then("the self-setup response detail mentions self-setup requires pending", function (this: ChatticusWorld) {
	assert.ok(responseDetail(this).includes("self-setup requires pending"), responseDetail(this));
});

Then("that pending organization is enabled in the deployment account as Anthus-managed", async function (this: ChatticusWorld) {
	const stored = await storedOrganizationOf(this, selfSetupOrganization(this).tenantId);
	assert.equal(stored.status, "enabled");
	assert.equal(stored.awsAccountId, SCENARIO_DEPLOYMENT_AWS_ACCOUNT_ID);
	assert.equal(stored.awsSetupPath, "anthus-managed");
	assert.equal(stored.awsCrossAccountRole, null);
});
