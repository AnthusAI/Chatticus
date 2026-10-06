import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { OrganizationsKernelImpl } from "../../src/domain/organizations.ts";
import type { Organization } from "../../src/domain/organizations.ts";
import { cognitoKeys, wireFrontDoor } from "../front-door.ts";
import { recordResponse, type RecordedResponse } from "../api.ts";
import { runMembersCliExpectingSuccess } from "../members-cli-process.ts";
import type { ChatticusWorld } from "../world.ts";
import { registerWorkerOverHttp } from "./worker-registration.ts";

const DEFAULT_OPERATOR_KEY = "test-operator-secret";
const DEFAULT_OWNER_EMAIL = "owner@example.com";
const DEFAULT_ORGANIZATION_NAME = "Anthus Labs";
const INVOKE_HEADER = "X-Chatticus-Invoke-Key";

const kernel = new OrganizationsKernelImpl();

/** State of one operator scenario: the organization under change, the credentials presented, the last response. */
export type OperatorScenarioState = {
	organization: Organization | null;
	configuredOperatorKey: string;
	operatorBearerToken: string | null;
	requestHeaders: Record<string, string>;
	ownerEmail: string;
	workerId: string | null;
	response: RecordedResponse | null;
};

function operatorState(world: ChatticusWorld): OperatorScenarioState {
	if (world.operatorScenario === null) {
		throw new Error("The operator HTTP front door is not wired in this scenario.");
	}
	return world.operatorScenario;
}

function scenarioOrganization(world: ChatticusWorld): Organization {
	const organization = operatorState(world).organization;
	if (organization === null) {
		throw new Error("No operator scenario organization is set.");
	}
	return organization;
}

function storeDependencies(world: ChatticusWorld) {
	return { store: world.messagingStore() };
}

function mergedHeaders(state: OperatorScenarioState): Record<string, string> {
	const headers = { ...state.requestHeaders };
	if (state.operatorBearerToken !== null) {
		headers["Authorization"] = `Bearer ${state.operatorBearerToken}`;
	}
	return headers;
}

async function wireOperatorFrontDoor(world: ChatticusWorld, operatorKey: string, invokeKey: string | null): Promise<void> {
	await wireFrontDoor(world, {
		signupMode: "invitation_only",
		cognitoVerifier: true,
		operatorKey,
		invokeKey,
	});
}

async function createPendingOrganization(world: ChatticusWorld, ownerEmail: string): Promise<Organization> {
	const owner = await kernel.signIn(ownerEmail, {
		store: world.messagingStore(),
		clock: world.clock,
		ids: world.ids,
	});
	return kernel.createOrganization(owner, DEFAULT_ORGANIZATION_NAME, {
		store: world.messagingStore(),
		clock: world.clock,
		ids: world.ids,
	});
}

async function callOperatorEndpoint(world: ChatticusWorld, action: string, headers: Record<string, string>): Promise<void> {
	assert.ok(world.api, "The scenario has no HTTP front door.");
	const organization = scenarioOrganization(world);
	operatorState(world).response = await recordResponse(
		await world.api.post(`/operator/orgs/${organization.tenantId}/${action}`, { headers }),
	);
}

function transitionError(action: string, organization: Organization, required: string): string {
	return `Organization ${JSON.stringify(organization.tenantId)} has status ${JSON.stringify(organization.status)}; ${action} requires ${required}.`;
}

Given(
	"the operator HTTP front door is wired with operator key {string}",
	async function (this: ChatticusWorld, operatorKey: string) {
		await wireOperatorFrontDoor(this, operatorKey, null);
		this.operatorScenario = {
			organization: null,
			configuredOperatorKey: operatorKey,
			operatorBearerToken: null,
			requestHeaders: {},
			ownerEmail: DEFAULT_OWNER_EMAIL,
			workerId: null,
			response: null,
		};
	},
);

Given("the operator HTTP front door has no operator key configured", async function (this: ChatticusWorld) {
	await wireOperatorFrontDoor(this, "", null);
	operatorState(this).configuredOperatorKey = "";
});

Given("the HTTP front door requires invoke key {string}", async function (this: ChatticusWorld, invokeKey: string) {
	const state = operatorState(this);
	await wireOperatorFrontDoor(this, state.configuredOperatorKey, invokeKey);
	state.requestHeaders = { [INVOKE_HEADER]: invokeKey };
});

Given("an organization in pending status", async function (this: ChatticusWorld) {
	const state = operatorState(this);
	state.organization = await createPendingOrganization(this, DEFAULT_OWNER_EMAIL);
});

Given("an organization in pending status for owner {string}", async function (this: ChatticusWorld, email: string) {
	const state = operatorState(this);
	state.organization = await createPendingOrganization(this, email);
	state.ownerEmail = email;
});

Given("an organization in enabled status", async function (this: ChatticusWorld) {
	const state = operatorState(this);
	const pending = await createPendingOrganization(this, DEFAULT_OWNER_EMAIL);
	state.organization = await kernel.enableOrganization(pending.tenantId, storeDependencies(this));
});

Given("an authenticated operator credential", function (this: ChatticusWorld) {
	const state = operatorState(this);
	state.operatorBearerToken = state.configuredOperatorKey || DEFAULT_OPERATOR_KEY;
});

Given("that organization has been suspended", async function (this: ChatticusWorld) {
	const state = operatorState(this);
	state.organization = await kernel.suspendOrganization(scenarioOrganization(this).tenantId, storeDependencies(this));
});

Given("a worker registered for that organization", async function (this: ChatticusWorld) {
	const state = operatorState(this);
	const organization = scenarioOrganization(this);
	state.workerId = "operator-test-worker";
	await registerWorkerOverHttp(this, {
		tenantId: organization.tenantId,
		workerId: state.workerId,
		costClass: "local",
		capabilities: ["cpu"],
		headers: state.requestHeaders,
	});
});

When("the operator calls the enable endpoint for that organization", async function (this: ChatticusWorld) {
	await callOperatorEndpoint(this, "enable", mergedHeaders(operatorState(this)));
});

When("the operator calls the suspend endpoint for that organization", async function (this: ChatticusWorld) {
	await callOperatorEndpoint(this, "suspend", mergedHeaders(operatorState(this)));
});

When("the operator calls the reinstate endpoint for that organization", async function (this: ChatticusWorld) {
	await callOperatorEndpoint(this, "reinstate", mergedHeaders(operatorState(this)));
});

When("a request without a valid operator credential calls the enable endpoint", async function (this: ChatticusWorld) {
	const state = operatorState(this);
	state.operatorBearerToken = null;
	await callOperatorEndpoint(this, "enable", mergedHeaders(state));
});

When("the owner calls the enable endpoint with a Cognito JWT", async function (this: ChatticusWorld) {
	const state = operatorState(this);
	const token = await (await cognitoKeys(this)).mintIdToken({ email: state.ownerEmail });
	await callOperatorEndpoint(this, "enable", { Authorization: `Bearer ${token}` });
});

When("the worker calls the enable endpoint with its bearer token", async function (this: ChatticusWorld) {
	const state = operatorState(this);
	assert.ok(state.workerId, "No worker is registered in this scenario.");
	const token = this.workerTokens.get(state.workerId);
	assert.ok(token, `No bearer token is stored for worker ${JSON.stringify(state.workerId)}.`);
	await callOperatorEndpoint(this, "enable", { Authorization: `Bearer ${token}` });
});

When("the enable endpoint is called with only the invoke key", async function (this: ChatticusWorld) {
	await callOperatorEndpoint(this, "enable", { ...operatorState(this).requestHeaders });
});

When("the enable endpoint is called with bearer {string}", async function (this: ChatticusWorld, token: string) {
	await callOperatorEndpoint(this, "enable", { Authorization: `Bearer ${token}` });
});

Then("the organization becomes enabled", async function (this: ChatticusWorld) {
	const updated = await kernel.getOrganization(scenarioOrganization(this).tenantId, storeDependencies(this));
	assert.equal(updated.status, "enabled");
});

Then("the organization becomes suspended", async function (this: ChatticusWorld) {
	const updated = await kernel.getOrganization(scenarioOrganization(this).tenantId, storeDependencies(this));
	assert.equal(updated.status, "suspended");
});

Then("the operator response status is {int}", function (this: ChatticusWorld, status: number) {
	const response = operatorState(this).response;
	assert.ok(response, "No operator response was recorded.");
	assert.equal(response.status, status, response.text);
});

Then("the organization status is unchanged", async function (this: ChatticusWorld) {
	const organization = scenarioOrganization(this);
	const updated = await kernel.getOrganization(organization.tenantId, storeDependencies(this));
	assert.equal(updated.status, organization.status);
});

Then("the organization status is suspended", async function (this: ChatticusWorld) {
	const updated = await kernel.getOrganization(scenarioOrganization(this).tenantId, storeDependencies(this));
	assert.equal(updated.status, "suspended");
});

Then("no computer exists for that organization", async function (this: ChatticusWorld) {
	assert.equal(await this.messagingStore().getComputer(scenarioOrganization(this).tenantId), null);
});

Then("the same state transition the members CLI produces occurs", async function (this: ChatticusWorld) {
	const organization = scenarioOrganization(this);
	const operatorEnabled = await kernel.getOrganization(organization.tenantId, storeDependencies(this));
	const twin = await createPendingOrganization(this, DEFAULT_OWNER_EMAIL);
	await runMembersCliExpectingSuccess(this, ["enable", twin.tenantId, "--yes"]);
	const cliEnabled = await kernel.getOrganization(twin.tenantId, storeDependencies(this));
	assert.equal(operatorEnabled.status, "enabled");
	assert.deepEqual(
		{ ...operatorEnabled, tenantId: "", createdAt: new Date(0) },
		{ ...cliEnabled, tenantId: "", createdAt: new Date(0) },
	);
	assert.equal(operatorEnabled.tenantId, organization.tenantId);
});

Then("the operator response detail matches the kernel enable transition error", function (this: ChatticusWorld) {
	const state = operatorState(this);
	assert.equal(state.response?.json?.detail, transitionError("enable", scenarioOrganization(this), "pending"));
});

Then("the operator response detail matches the kernel suspend transition error", function (this: ChatticusWorld) {
	const state = operatorState(this);
	assert.equal(state.response?.json?.detail, transitionError("suspend", scenarioOrganization(this), "enabled"));
});

Then("the operator response detail matches the kernel reinstate transition error", function (this: ChatticusWorld) {
	const state = operatorState(this);
	assert.equal(state.response?.json?.detail, transitionError("reinstate", scenarioOrganization(this), "suspended"));
});
