import assert from "node:assert/strict";
import { ensureComputer } from "../src/domain/computers.ts";
import { OrganizationsKernelImpl, type Organization } from "../src/domain/organizations.ts";
import { OrganizationComputerHostStarter, type DeploymentEcsConfig } from "../src/computer/host-starter.ts";
import { OrganizationComputerProvisioningError } from "../src/http/errors.ts";
import type { CustomerComputersProvisioner } from "../src/computer/customer-stack.ts";
import type { EcrPort, SessionCredentials } from "../src/computer/aws-ports.ts";
import {
	CUSTOMER_ACCOUNT_ID,
	DEPLOYMENT_ACCOUNT_ID,
	FakeCloudFormation,
	FakeEcr,
	MultiAccountEcsRecorder,
	RecordingAssumeRole,
	unreachableAssumeRole,
} from "./fakes/fake-customer-aws.ts";
import type { ChatticusWorld } from "./world.ts";

const kernel = new OrganizationsKernelImpl();

export { CUSTOMER_ACCOUNT_ID, DEPLOYMENT_ACCOUNT_ID };

/** The deployment-account ECS wiring every host start scenario runs the starter with. */
export const DEPLOYMENT_ECS_CONFIG: DeploymentEcsConfig = {
	cluster: "deployment-cluster",
	taskDefinition: "computer:1",
	subnets: ["subnet-deploy-1"],
	securityGroups: ["sg-deploy-1"],
};

/** Everything one host start scenario drives and observes: the starter, the fake AWS accounts and the last refusal. */
export interface CustomerComputeScenario {
	organization: Organization | null;
	starter: OrganizationComputerHostStarter;
	assumeRole: RecordingAssumeRole;
	cloudformation: FakeCloudFormation;
	ecs: MultiAccountEcsRecorder;
	ecr: FakeEcr;
	ecrClientsOpened: Array<SessionCredentials | null>;
	cloudformationClientsOpened: Array<SessionCredentials | null>;
	startError: OrganizationComputerProvisioningError | null;
	deleteCallsAtLastCheck: number;
	publishOrganization: Organization | null;
	anthusEcr: FakeEcr | null;
	customerEcr: FakeEcr | null;
	publishAssumeRole: RecordingAssumeRole | null;
	publishedImageUri: string | null;
	customerEcrCredentials: SessionCredentials | null;
	unreachableRole: boolean;
	startConditions: StartConditions | null;
}

/** What the starter was up against when it was last asked to start, kept to name the refusal it should give. */
export interface StartConditions {
	readonly hasAwsHome: boolean;
	readonly roleUnreachable: boolean;
	readonly stackPresent: boolean;
	readonly stackStatus: string | null;
	readonly deleteDenied: boolean;
}

/** The scenario's host start state, or a failure when no organization was wired for a host start. */
export function computeScenario(world: ChatticusWorld): CustomerComputeScenario {
	assert.ok(world.customerCompute, "No organization is wired for a computer start in this scenario.");
	return world.customerCompute;
}

/** An enabled organization recorded with a customer-owned AWS home, created through the production kernel. */
export async function provisionCrossAccountOrganization(
	world: ChatticusWorld,
	options: { name: string; ownerEmail: string; accountId: string; externalId?: string },
): Promise<Organization> {
	const deps = { store: world.messagingStore(), clock: world.clock, ids: world.ids };
	const owner = await kernel.signIn(options.ownerEmail, deps);
	const organization = await kernel.createOrganization(owner, options.name, deps);
	await kernel.enableOrganization(organization.tenantId, deps);
	return kernel.provisionOrganizationAws(
		organization.tenantId,
		{
			accountId: options.accountId,
			crossAccountRole: `arn:aws:iam::${options.accountId}:role/ChatticusOrganizationComputerRole`,
			externalId: options.externalId ?? organization.tenantId,
			setupPath: "customer-owned",
		},
		deps,
	);
}

/** The fake AWS accounts one host start scenario's starter opens clients into. */
export interface HostStarterFakes {
	assumeRole: RecordingAssumeRole;
	unreachableRole: boolean;
	cloudformation: FakeCloudFormation;
	ecs: MultiAccountEcsRecorder;
	ecr: FakeEcr;
}

/**
 * Wire the production host starter over the scenario's store with fakes for every AWS account it can open: the
 * deployment account's ECS, and the customer account's CloudFormation, ECS and ECR under the assumed role.
 */
export function wireHostStarter(
	world: ChatticusWorld,
	options: {
		organization: Organization | null;
		fakes?: Partial<HostStarterFakes>;
		customerComputersProvisioner?: CustomerComputersProvisioner;
	},
): CustomerComputeScenario {
	const previous = world.customerCompute;
	const fakes: HostStarterFakes = {
		assumeRole: options.fakes?.assumeRole ?? new RecordingAssumeRole(),
		unreachableRole: options.fakes?.unreachableRole ?? false,
		cloudformation: options.fakes?.cloudformation ?? new FakeCloudFormation(),
		ecs: options.fakes?.ecs ?? new MultiAccountEcsRecorder(),
		ecr: options.fakes?.ecr ?? previous?.ecr ?? new FakeEcr(),
	};
	const ecrClientsOpened: Array<SessionCredentials | null> = [];
	const cloudformationClientsOpened: Array<SessionCredentials | null> = [];
	const starter = new OrganizationComputerHostStarter({
		getOrganization: (tenantId) => kernel.getOrganization(tenantId, { store: world.messagingStore() }),
		deploymentAccountId: DEPLOYMENT_ACCOUNT_ID,
		deploymentEcsConfig: DEPLOYMENT_ECS_CONFIG,
		assumeRole: fakes.unreachableRole ? unreachableAssumeRole : fakes.assumeRole.port,
		ecsClientFactory: fakes.ecs.factory,
		cloudformationClientFactory: (credentials) => {
			cloudformationClientsOpened.push(credentials);
			return fakes.cloudformation;
		},
		ecrClientFactory: (credentials): EcrPort => {
			ecrClientsOpened.push(credentials);
			return fakes.ecr;
		},
		customerComputersProvisioner: options.customerComputersProvisioner,
		environment: {},
	});
	const scenario: CustomerComputeScenario = {
		organization: options.organization,
		starter,
		assumeRole: fakes.assumeRole,
		cloudformation: fakes.cloudformation,
		ecs: fakes.ecs,
		ecr: fakes.ecr,
		ecrClientsOpened,
		cloudformationClientsOpened,
		startError: null,
		deleteCallsAtLastCheck: 0,
		publishOrganization: previous?.publishOrganization ?? null,
		anthusEcr: previous?.anthusEcr ?? null,
		customerEcr: previous?.customerEcr ?? null,
		publishAssumeRole: previous?.publishAssumeRole ?? null,
		publishedImageUri: previous?.publishedImageUri ?? null,
		customerEcrCredentials: previous?.customerEcrCredentials ?? null,
		unreachableRole: fakes.unreachableRole,
		startConditions: null,
	};
	world.customerCompute = scenario;
	return scenario;
}

/** Ask the starter to start the organization's computer, keeping a provisioning refusal for the Then steps. */
export async function startOrganizationComputer(world: ChatticusWorld, organization: Organization): Promise<void> {
	const scenario = computeScenario(world);
	const computer = await ensureComputer(organization.tenantId, { store: world.messagingStore(), ids: world.ids });
	scenario.startError = null;
	scenario.startConditions = {
		hasAwsHome: organization.awsCrossAccountRole !== null,
		roleUnreachable: scenario.unreachableRole,
		stackPresent: scenario.cloudformation.stackPresent,
		stackStatus: scenario.cloudformation.stackStatus,
		deleteDenied: scenario.cloudformation.deleteDenied,
	};
	try {
		await scenario.starter.startHost({
			tenantId: organization.tenantId,
			computerId: computer.computerId,
			hostStartCount: 1,
			userId: "owner-user",
		});
	} catch (error) {
		if (!(error instanceof OrganizationComputerProvisioningError)) {
			throw error;
		}
		scenario.startError = error;
	}
}
