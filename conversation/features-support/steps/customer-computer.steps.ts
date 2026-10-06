import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { OrganizationsKernelImpl, type Organization } from "../../src/domain/organizations.ts";
import { OrganizationComputerProvisioningError } from "../../src/http/errors.ts";
import { attemptCrossAccountAssumeRole } from "../../src/computer/provisioning.ts";
import {
	COMPUTER_REPOSITORY_URI_OUTPUT,
	RefusingCustomerComputersProvisioner,
	describeCustomerComputersStack,
	stackOutputsFromDescribeStacks,
} from "../../src/computer/customer-stack.ts";
import {
	publishDevImageFromAnthus,
	repositoryNameFromUri,
	requireCustomerComputerImage,
} from "../../src/computer/customer-image.ts";
import { loadCustomerComputersTemplate } from "../../src/computer/customer-template.ts";
import {
	CUSTOMER_ACCOUNT_ID,
	DEPLOYMENT_ACCOUNT_ID,
	computeScenario,
	provisionCrossAccountOrganization,
	startOrganizationComputer,
	wireHostStarter,
} from "../customer-computer.ts";
import { ASSUMED_ACCESS_KEY_ID, FakeCloudFormation, FakeEcr, RecordingAssumeRole } from "../fakes/fake-customer-aws.ts";
import { selfSetupScenario } from "../customer-self-setup.ts";
import type { ChatticusWorld } from "../world.ts";

const kernel = new OrganizationsKernelImpl();
const ANTHUS_MANIFEST = '{"schemaVersion":2,"mediaType":"application/vnd.docker.distribution.manifest.v2+json"}';

async function givenCustomerOrganization(
	world: ChatticusWorld,
	name: string,
	ownerEmail: string,
	externalId: string,
	cloudformation: FakeCloudFormation,
): Promise<void> {
	const organization = await provisionCrossAccountOrganization(world, {
		name,
		ownerEmail,
		accountId: CUSTOMER_ACCOUNT_ID,
		externalId,
	});
	wireHostStarter(world, { organization, fakes: { cloudformation } });
}

function startOrganization(world: ChatticusWorld): Organization {
	const scenario = world.customerCompute;
	const organization = scenario?.organization ?? selfSetupScenario(world).pendingOrganization;
	assert.ok(organization, "No organization is set for a computer start in this scenario.");
	return organization;
}

function startErrorMessage(world: ChatticusWorld): string {
	const error = computeScenario(world).startError;
	assert.ok(error instanceof OrganizationComputerProvisioningError, "The start was not refused with a provisioning error.");
	return error.message;
}

Given(
	"an organization provisioned into a customer AWS account with a ChatticusComputers stack",
	async function (this: ChatticusWorld) {
		await givenCustomerOrganization(this, "Customer Org", "customer-start@example.com", "customer-org-external-id", new FakeCloudFormation());
	},
);

Given(
	"an organization provisioned into a customer AWS account without a ChatticusComputers stack",
	async function (this: ChatticusWorld) {
		await givenCustomerOrganization(
			this,
			"Customer Org Missing Stack",
			"missing-stack@example.com",
			"customer-org-missing-stack",
			new FakeCloudFormation({ stackPresent: false }),
		);
	},
);

Given(
	"an organization provisioned into a customer AWS account with a failed ChatticusComputers stack in {word} status",
	async function (this: ChatticusWorld, status: string) {
		await givenCustomerOrganization(
			this,
			"Failed Stack Org",
			"failed-stack@example.com",
			"failed-stack-external-id",
			new FakeCloudFormation({ stackStatus: status, createResultStatus: "CREATE_IN_PROGRESS" }),
		);
	},
);

Given(
	"an organization provisioned into a customer AWS account whose ChatticusComputers stack was deleted",
	async function (this: ChatticusWorld) {
		await givenCustomerOrganization(
			this,
			"Deleted Stack Org",
			"deleted-stack@example.com",
			"deleted-stack-external-id",
			new FakeCloudFormation({ stackPresent: false, createResultStatus: "CREATE_IN_PROGRESS" }),
		);
	},
);

Given(
	"an organization provisioned into a customer AWS account with a CREATE_COMPLETE ChatticusComputers stack with legacy outputs only",
	async function (this: ChatticusWorld) {
		await givenCustomerOrganization(
			this,
			"Legacy Output Org",
			"legacy-outputs@example.com",
			"legacy-outputs-external-id",
			new FakeCloudFormation({ stackStatus: "CREATE_COMPLETE", outputProfile: "legacy" }),
		);
	},
);

Given(
	"an organization provisioned into a customer AWS account with a ChatticusComputers stack in UPDATE_COMPLETE status without subnet outputs",
	async function (this: ChatticusWorld) {
		await givenCustomerOrganization(
			this,
			"Incomplete Update Org",
			"incomplete-update@example.com",
			"incomplete-update-external-id",
			new FakeCloudFormation({ stackStatus: "UPDATE_COMPLETE", outputProfile: "legacy" }),
		);
	},
);

Given("an Anthus-managed organization homed in the deployment AWS account", async function (this: ChatticusWorld) {
	const organization = await kernel.adminSeedOrganization("anthus-managed", "anthus-owner@example.com", "Anthus Managed", {
		store: this.messagingStore(),
		clock: this.clock,
		ids: this.ids,
		callerAwsAccountId: async () => DEPLOYMENT_ACCOUNT_ID,
	});
	wireHostStarter(this, { organization });
});

Given("an organization whose cross-account role cannot be assumed", async function (this: ChatticusWorld) {
	const organization = await provisionCrossAccountOrganization(this, {
		name: "Unreachable Org",
		ownerEmail: "unreachable@example.com",
		accountId: CUSTOMER_ACCOUNT_ID,
		externalId: "unreachable-external-id",
	});
	wireHostStarter(this, { organization, fakes: { unreachableRole: true } });
});

Given("the host starter cannot provision customer infrastructure", function (this: ChatticusWorld) {
	const scenario = computeScenario(this);
	wireHostStarter(this, {
		organization: scenario.organization,
		fakes: {
			assumeRole: scenario.assumeRole,
			cloudformation: scenario.cloudformation,
			ecs: scenario.ecs,
			ecr: scenario.ecr,
		},
		customerComputersProvisioner: new RefusingCustomerComputersProvisioner(),
	});
});

Given("DeleteStack is denied for the customer CloudFormation client", function (this: ChatticusWorld) {
	computeScenario(this).cloudformation.deleteDenied = true;
});

When("DeleteStack is allowed for the customer CloudFormation client", function (this: ChatticusWorld) {
	computeScenario(this).cloudformation.deleteDenied = false;
});

When("the ChatticusComputers stack finishes deleting", function (this: ChatticusWorld) {
	computeScenario(this).cloudformation.setStackMissing();
});

When("the ChatticusComputers stack finishes creating", function (this: ChatticusWorld) {
	computeScenario(this).cloudformation.setStackStatus("CREATE_COMPLETE");
});

Given("the ChatticusComputers stack is terminal-failed in {word} status", function (this: ChatticusWorld, status: string) {
	computeScenario(this).cloudformation.setStackStatus(status);
});

Given("UpdateStack reports no changes for the customer CloudFormation client", function (this: ChatticusWorld) {
	computeScenario(this).cloudformation.updateNoOp = true;
});

When("the ChatticusComputers stack finishes updating", function (this: ChatticusWorld) {
	computeScenario(this).cloudformation.finishStackUpdate();
});

Given("the customer computer image tag dev exists", function (this: ChatticusWorld) {
	computeScenario(this).ecr.hasDevTag = true;
});

Given("the customer computer repository has no dev tag", function (this: ChatticusWorld) {
	computeScenario(this).ecr.hasDevTag = false;
});

When("its computer starts", async function (this: ChatticusWorld) {
	if (this.customerCompute === null) {
		wireHostStarter(this, { organization: startOrganization(this) });
	}
	await startOrganizationComputer(this, startOrganization(this));
});

When("its computer is asked to start", async function (this: ChatticusWorld) {
	if (this.customerCompute === null) {
		wireHostStarter(this, { organization: startOrganization(this) });
	}
	await startOrganizationComputer(this, startOrganization(this));
});

Then("the instance is launched in the customer account", function (this: ChatticusWorld) {
	const scenario = computeScenario(this);
	assert.equal(scenario.starter.lastOutcome?.launchAccountId, CUSTOMER_ACCOUNT_ID);
	assert.equal(scenario.ecs.customer.calls.length, 1);
	assert.ok(scenario.cloudformation.describeCalls.length >= 1);
	const assumed = scenario.ecs.customerClientsOpened;
	assert.ok(assumed.length >= 1);
	assert.ok(assumed.every((credentials) => credentials.accessKeyId === ASSUMED_ACCESS_KEY_ID));
});

Then("the organization's cross-account role was assumed", function (this: ChatticusWorld) {
	const scenario = computeScenario(this);
	const organization = scenario.organization;
	assert.ok(organization);
	assert.equal(scenario.assumeRole.calls.length, 1);
	assert.equal(scenario.assumeRole.calls[0]?.RoleArn, organization.awsCrossAccountRole);
	assert.equal(scenario.assumeRole.calls[0]?.ExternalId, organization.awsExternalId);
});

Then("the instance is launched with deployment credentials", function (this: ChatticusWorld) {
	const scenario = computeScenario(this);
	assert.equal(scenario.starter.lastOutcome?.launchAccountId, DEPLOYMENT_ACCOUNT_ID);
	assert.equal(scenario.ecs.deployment.calls.length, 1);
	assert.deepEqual(scenario.ecs.deploymentClientsOpened, [null]);
});

Then("AssumeRole is not called", function (this: ChatticusWorld) {
	assert.equal(computeScenario(this).assumeRole.calls.length, 0);
});

Then("no ECS client is opened in a customer account", function (this: ChatticusWorld) {
	const scenario = computeScenario(this);
	assert.equal(scenario.ecs.customerClientsOpened.length, 0);
	assert.equal(scenario.ecs.customer.calls.length, 0);
});

Then("no compute for that organization runs in the Anthus account", function (this: ChatticusWorld) {
	assert.equal(computeScenario(this).ecs.deployment.calls.length, 0);
});

Then("no instance is launched in the Anthus account", function (this: ChatticusWorld) {
	assert.equal(computeScenario(this).ecs.deployment.calls.length, 0);
});

Then("the start is refused with a provisioning error", function (this: ChatticusWorld) {
	const message = startErrorMessage(this).toLowerCase();
	assert.ok(message.includes("provisioning") || message.includes("refused"), message);
});

Then("the start is refused with a provisioning error naming the missing stack", function (this: ChatticusWorld) {
	const message = startErrorMessage(this).toLowerCase();
	assert.ok(message.includes("chatticuscomputers"), message);
	assert.ok(message.includes("does not exist") || message.includes("missing"), message);
});

Then("the start is refused with a provisioning error naming incomplete outputs", function (this: ChatticusWorld) {
	const message = startErrorMessage(this).toLowerCase();
	assert.ok(message.includes("incomplete") || message.includes("computerpublicsubnetids"), message);
	assert.ok(message.includes("chatticuscomputers"), message);
});

Then("the start is refused with a provisioning error naming the missing computer image", function (this: ChatticusWorld) {
	const message = startErrorMessage(this).toLowerCase();
	assert.ok(message.includes("missing") || message.includes("publish"), message);
	assert.ok(message.includes("dev"), message);
});

Then("Chatticus creates the ChatticusComputers stack in the customer account", function (this: ChatticusWorld) {
	const calls = computeScenario(this).cloudformation.createStackCalls;
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.StackName, "ChatticusComputers");
	assert.ok(calls[0]?.Capabilities.includes("CAPABILITY_IAM"));
	assert.ok(calls[0]?.Capabilities.includes("CAPABILITY_NAMED_IAM"));
});

Then("Chatticus does not create the ChatticusComputers stack", function (this: ChatticusWorld) {
	assert.equal(computeScenario(this).cloudformation.createStackCalls.length, 0);
});

Then("Chatticus describes the ChatticusComputers stack in the customer account", function (this: ChatticusWorld) {
	const calls = computeScenario(this).cloudformation.describeCalls;
	assert.ok(calls.length >= 1);
	assert.equal(calls[0]?.StackName, "ChatticusComputers");
});

Then("Chatticus deletes the ChatticusComputers stack in the customer account", function (this: ChatticusWorld) {
	const scenario = computeScenario(this);
	const calls = scenario.cloudformation.deleteStackCalls;
	assert.equal(calls.length, scenario.deleteCallsAtLastCheck + 1);
	scenario.deleteCallsAtLastCheck = calls.length;
	assert.equal(calls[calls.length - 1]?.StackName, "ChatticusComputers");
});

Then("Chatticus does not delete the ChatticusComputers stack", function (this: ChatticusWorld) {
	assert.equal(computeScenario(this).cloudformation.deleteStackCalls.length, 0);
});

Then("Chatticus updates the ChatticusComputers stack in the customer account", function (this: ChatticusWorld) {
	const calls = computeScenario(this).cloudformation.updateStackCalls;
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.StackName, "ChatticusComputers");
	assert.ok(calls[0]?.Capabilities.includes("CAPABILITY_IAM"));
	assert.ok(calls[0]?.Capabilities.includes("CAPABILITY_NAMED_IAM"));
});

Then("Anthus does not grant cross-account ECR pull for the customer account", function (this: ChatticusWorld) {
	const scenario = computeScenario(this);
	assert.ok(
		scenario.ecrClientsOpened.every((credentials) => credentials !== null),
		"An ECR client was opened with Anthus credentials; Anthus must not touch its own ECR for a customer start.",
	);
	assert.ok(scenario.cloudformationClientsOpened.every((credentials) => credentials !== null));
});

Then("no customer ECS RunTask was attempted", function (this: ChatticusWorld) {
	const scenario = computeScenario(this);
	assert.equal(scenario.ecs.customer.calls.length, 0);
	assert.equal(scenario.ecs.deployment.calls.length, 0);
});

Then("the committed customer ChatticusComputers template declares an ECR repository", function (this: ChatticusWorld) {
	const resources = Object.values(loadCustomerComputersTemplate().Resources ?? {}) as Array<{ Type?: string }>;
	assert.ok(resources.some((resource) => resource.Type === "AWS::ECR::Repository"));
});

Then("CreateStack parameters include TenantId and SnapshotBucketName", function (this: ChatticusWorld) {
	const scenario = computeScenario(this);
	assert.equal(scenario.cloudformation.createStackCalls.length, 1);
	const tenantId = scenario.organization?.tenantId;
	assert.ok(tenantId);
	assert.deepEqual(scenario.cloudformation.createStackCalls[0]?.Parameters, [
		{ ParameterKey: "TenantId", ParameterValue: tenantId },
		{ ParameterKey: "SnapshotBucketName", ParameterValue: `chatticus-snapshots-${tenantId}` },
	]);
});

Then("CreateStack parameters include SnapshotBucketName for the organization", function (this: ChatticusWorld) {
	const scenario = computeScenario(this);
	assert.equal(scenario.cloudformation.createStackCalls.length, 1);
	const tenantId = scenario.organization?.tenantId;
	assert.ok(tenantId);
	assert.deepEqual(scenario.cloudformation.createStackCalls[0]?.Parameters, [
		{ ParameterKey: "TenantId", ParameterValue: tenantId },
		{ ParameterKey: "SnapshotBucketName", ParameterValue: `chatticus-snapshots-${tenantId}` },
	]);
});

Then("the RunTask task definition image URI is in the customer AWS account", function (this: ChatticusWorld) {
	const calls = computeScenario(this).ecs.customer.calls;
	assert.equal(calls.length, 1);
	assert.ok(calls[0]?.taskDefinition.includes(CUSTOMER_ACCOUNT_ID), calls[0]?.taskDefinition);
});

Given("a ChatticusComputers stack with an empty customer ECR repository", async function (this: ChatticusWorld) {
	const organization = await provisionCrossAccountOrganization(this, {
		name: "Publish Org",
		ownerEmail: "publish@example.com",
		accountId: CUSTOMER_ACCOUNT_ID,
	});
	const scenario = wireHostStarter(this, { organization, fakes: { cloudformation: new FakeCloudFormation() } });
	scenario.publishOrganization = organization;
	scenario.customerEcr = new FakeEcr({ hasDevTag: false });
	scenario.anthusEcr = new FakeEcr({ hasDevTag: true, anthusManifest: ANTHUS_MANIFEST });
	scenario.publishAssumeRole = new RecordingAssumeRole();
});

When("the customer computer image is published from Anthus dev", async function (this: ChatticusWorld) {
	const scenario = computeScenario(this);
	const organization = scenario.publishOrganization;
	assert.ok(organization && scenario.customerEcr && scenario.anthusEcr && scenario.publishAssumeRole);
	const outcome = await attemptCrossAccountAssumeRole(organization, { assumeRole: scenario.publishAssumeRole.port });
	assert.ok(outcome.session, "The organization cross-account role was not assumed for the publish.");
	scenario.customerEcrCredentials = {
		accessKeyId: outcome.session.accessKeyId,
		secretAccessKey: outcome.session.secretAccessKey,
		sessionToken: outcome.session.sessionToken,
	};
	const outputs = stackOutputsFromDescribeStacks(await describeCustomerComputersStack(scenario.cloudformation));
	const repositoryUri = outputs[COMPUTER_REPOSITORY_URI_OUTPUT];
	assert.ok(repositoryUri, "The customer stack has no computer repository.");
	await publishDevImageFromAnthus(scenario.anthusEcr, scenario.customerEcr, {
		anthusRepositoryName: "chatticuscomputers-computerimage",
		customerRepositoryName: repositoryNameFromUri(repositoryUri),
	});
	scenario.publishedImageUri = await requireCustomerComputerImage(scenario.customerEcr, { repositoryUri });
});

Then("the publish used the organization cross-account role", function (this: ChatticusWorld) {
	const scenario = computeScenario(this);
	const organization = scenario.publishOrganization;
	assert.ok(organization && scenario.publishAssumeRole && scenario.customerEcr);
	assert.equal(scenario.publishAssumeRole.calls.length, 1);
	assert.equal(scenario.publishAssumeRole.calls[0]?.RoleArn, organization.awsCrossAccountRole);
	assert.equal(scenario.publishAssumeRole.calls[0]?.ExternalId, organization.awsExternalId);
	assert.equal(scenario.customerEcrCredentials?.accessKeyId, ASSUMED_ACCESS_KEY_ID);
	assert.deepEqual(scenario.customerEcr.putImageCalls, [
		{ repositoryName: "chatticuscomputers-computerimage", imageManifest: ANTHUS_MANIFEST, imageTag: "dev" },
	]);
});

Then("the published image URI is in the customer AWS account", function (this: ChatticusWorld) {
	const published = computeScenario(this).publishedImageUri;
	assert.ok(published);
	assert.ok(published.startsWith(`${CUSTOMER_ACCOUNT_ID}.dkr.ecr.`), published);
	assert.ok(published.endsWith(":dev"), published);
});
