/**
 * Start organization computers in the account recorded as their AWS home. An Anthus-managed organization starts in
 * the deployment account; a customer organization starts in its own account under an ExternalId-guarded
 * AssumeRole. A start that cannot reach the customer account is refused, never run in the Anthus account.
 * The host protocol (the nine HTTP routes) is the only way a customer-account computer reaches Chatticus data.
 * Ported from python/src/chatticus/organization_computer_host.py lines 1-371 and
 * python/src/chatticus/deployment_aws_account.py lines 1-31, and python/src/chatticus/host_starter.py lines 1-55.
 */

import { OrganizationComputerProvisioningError } from "../http/errors.ts";
import type { ComputerStartJob, HostStartDriver } from "../domain/computer-start.ts";
import type { HostStartClaim as DomainHostStartClaim } from "../domain/computers.ts";
import type { Organization } from "../domain/organizations.ts";
import type { AssumeRolePort, CloudFormationPort, EcrPort, EcsPort, SessionCredentials } from "./aws-ports.ts";
import {
	defaultAssumeRole,
	defaultCloudFormationClient,
	defaultEcrClient,
	defaultEcsClient,
} from "./aws-clients.ts";
import { requireCustomerComputerImage } from "./customer-image.ts";
import {
	AwsCustomerComputersProvisioner,
	COMPUTERS_STACK_NAME,
	COMPUTER_REPOSITORY_URI_OUTPUT,
	CustomerStackOutputsIncompleteError,
	customerComputerEcsConfigFromStackOutputs,
	describeCustomerComputersStack,
	stackOutputsFromDescribeStacks,
	type CustomerComputerEcsConfig,
	type CustomerComputersProvisioner,
} from "./customer-stack.ts";
import { attemptCrossAccountAssumeRole } from "./provisioning.ts";

export const TENANT_TAG_KEY = "chatticus:tenant";

/** The deployment AWS account id is not configured. */
export class DeploymentAwsAccountIdError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DeploymentAwsAccountIdError";
	}
}

/** Environment variables the starter reads; defaults to the process environment. */
export type StarterEnvironment = Readonly<Record<string, string | undefined>>;

/** Conditional start for one computer. */
export interface HostStartClaim {
	tenantId: string;
	computerId: string;
	hostStartCount: number;
	userId: string;
}

/** Same-account ECS wiring from deployment environment variables. */
export interface DeploymentEcsConfig {
	cluster: string;
	taskDefinition: string;
	subnets: string[];
	securityGroups: string[];
}

/** Observable result of one organization host start attempt. */
export interface OrganizationHostStartOutcome {
	launchAccountId: string;
	refused: boolean;
}

function environmentValue(environment: StarterEnvironment, key: string): string {
	return (environment[key] ?? "").trim();
}

/** Return the twelve-digit AWS account id where this deployment runs; there is no default. */
export function deploymentAwsAccountId(environment: StarterEnvironment = process.env): string {
	const configured = environmentValue(environment, "CHATTICUS_DEPLOYMENT_AWS_ACCOUNT_ID");
	if (configured !== "") {
		return configured;
	}
	throw new DeploymentAwsAccountIdError(
		"CHATTICUS_DEPLOYMENT_AWS_ACCOUNT_ID is not set; the deployment AWS account id is required.",
	);
}

/** Return deployment ECS wiring when CHATTICUS_HOST_STARTER selects ecs. */
export function deploymentEcsConfigFromEnvironment(environment: StarterEnvironment = process.env): DeploymentEcsConfig | null {
	const kind = (environment.CHATTICUS_HOST_STARTER ?? "noop").trim().toLowerCase();
	if (kind !== "ecs") {
		return null;
	}
	const cluster = environmentValue(environment, "CHATTICUS_ECS_CLUSTER");
	const taskDefinition = environmentValue(environment, "CHATTICUS_ECS_TASK_DEFINITION");
	const subnets = environmentValue(environment, "CHATTICUS_ECS_SUBNETS")
		.split(",")
		.filter((part) => part !== "");
	const securityGroups = environmentValue(environment, "CHATTICUS_ECS_SECURITY_GROUPS")
		.split(",")
		.filter((part) => part !== "");
	if (cluster === "" || taskDefinition === "" || subnets.length === 0) {
		return null;
	}
	return { cluster, taskDefinition, subnets, securityGroups };
}

/** Read one customer-account ChatticusComputers stack for RunTask wiring. */
export async function lookupCustomerComputerEcsConfig(
	cloudformation: CloudFormationPort,
	stackName: string = COMPUTERS_STACK_NAME,
): Promise<CustomerComputerEcsConfig> {
	const stackResponse = await describeCustomerComputersStack(cloudformation, stackName);
	const outputs = stackOutputsFromDescribeStacks(stackResponse);
	try {
		return customerComputerEcsConfigFromStackOutputs(outputs);
	} catch (error) {
		if (error instanceof CustomerStackOutputsIncompleteError) {
			throw new OrganizationComputerProvisioningError(error.message);
		}
		throw error;
	}
}

function requireAwsHome(organization: Organization): string {
	if (organization.awsAccountId === null || organization.awsAccountId === "") {
		throw new OrganizationComputerProvisioningError(
			`Organization ${JSON.stringify(organization.tenantId)} has no AWS home; computer provisioning is required before start.`,
		);
	}
	return organization.awsAccountId;
}

function requireCrossAccountFields(organization: Organization): void {
	if (organization.awsCrossAccountRole === null || organization.awsExternalId === null) {
		throw new OrganizationComputerProvisioningError(
			`Organization ${JSON.stringify(organization.tenantId)} is homed in another AWS account but has no cross-account role recorded.`,
		);
	}
}

/** Tags for one computer task: the standard cost tags plus its organization. */
export function hostTaskTags(claim: HostStartClaim, environment: StarterEnvironment = process.env): Array<{ key: string; value: string }> {
	const tags = [
		{ key: "chatticus:application", value: "Chatticus" },
		{ key: "chatticus:component", value: "computer" },
		{ key: TENANT_TAG_KEY, value: claim.tenantId },
		{ key: "computer_id", value: claim.computerId },
		{ key: "host_start_generation", value: String(claim.hostStartCount) },
	];
	const deploymentEnvironment = environmentValue(environment, "CHATTICUS_ENVIRONMENT");
	if (deploymentEnvironment !== "") {
		tags.push({ key: "chatticus:environment", value: deploymentEnvironment });
	}
	const installation = environmentValue(environment, "CHATTICUS_INSTALLATION_NAME");
	if (installation !== "") {
		tags.push({ key: "chatticus:installation", value: installation });
	}
	return tags;
}

function runTaskOverrides(claim: HostStartClaim, environment: StarterEnvironment) {
	const command = environmentValue(environment, "CHATTICUS_ECS_HOST_COMMAND");
	if (command === "") {
		return {};
	}
	if (claim.userId === "") {
		throw new Error("host start claim requires a non-empty user_id");
	}
	const container = (environment.CHATTICUS_ECS_CONTAINER_NAME ?? "computer").trim();
	const containerEnvironment = [
		{ name: "CHATTICUS_TENANT_ID", value: claim.tenantId },
		{ name: "CHATTICUS_USER_ID", value: claim.userId },
	];
	for (const key of [
		"CHATTICUS_FRONT_DOOR_URL",
		"CHATTICUS_INVOKE_KEY",
		"CHATTICUS_ENVIRONMENT",
		"AWS_REGION",
		"AWS_DEFAULT_REGION",
	]) {
		const value = environmentValue(environment, key);
		if (value !== "") {
			containerEnvironment.push({ name: key, value });
		}
	}
	return {
		overrides: {
			containerOverrides: [{ name: container, command: command.split(/\s+/).filter((part) => part !== ""), environment: containerEnvironment }],
		},
	};
}

/** Run one Fargate task for a host-start claim. */
export async function runFargateTask(
	ecs: EcsPort,
	options: {
		cluster: string;
		taskDefinition: string;
		subnets: string[];
		securityGroups: string[];
		claim: HostStartClaim;
		environment?: StarterEnvironment;
	},
): Promise<void> {
	const environment = options.environment ?? process.env;
	const response = await ecs.runTask({
		cluster: options.cluster,
		taskDefinition: options.taskDefinition,
		launchType: "FARGATE",
		networkConfiguration: {
			awsvpcConfiguration: {
				subnets: options.subnets,
				securityGroups: options.securityGroups,
				assignPublicIp: "ENABLED",
			},
		},
		tags: hostTaskTags(options.claim, environment),
		...runTaskOverrides(options.claim, environment),
	});
	const failures = response?.failures ?? [];
	const tasks = response?.tasks ?? [];
	if (failures.length > 0 || tasks.length === 0) {
		throw new Error(`ecs.run_task returned no tasks failures=${JSON.stringify(failures)}`);
	}
}

/** What the starter reads and calls; every AWS call is a port. */
export interface OrganizationHostStarterOptions {
	getOrganization: (tenantId: string) => Promise<Organization>;
	deploymentAccountId?: string;
	deploymentEcsConfig?: DeploymentEcsConfig | null;
	assumeRole?: AssumeRolePort;
	ecsClientFactory?: (credentials: SessionCredentials | null) => EcsPort;
	cloudformationClientFactory?: (credentials: SessionCredentials | null) => CloudFormationPort;
	ecrClientFactory?: (credentials: SessionCredentials | null) => EcrPort;
	customerComputersProvisioner?: CustomerComputersProvisioner;
	environment?: StarterEnvironment;
}

/** Summon one computer host in the organization's recorded AWS home. */
export class OrganizationComputerHostStarter {
	lastOutcome: OrganizationHostStartOutcome | null = null;

	private readonly getOrganization: (tenantId: string) => Promise<Organization>;
	private readonly environment: StarterEnvironment;
	private readonly deploymentAccountId: string;
	private readonly deploymentEcsConfig: DeploymentEcsConfig | null;
	private readonly assumeRole: AssumeRolePort;
	private readonly ecsClientFactory: (credentials: SessionCredentials | null) => EcsPort;
	private readonly cloudformationClientFactory: (credentials: SessionCredentials | null) => CloudFormationPort;
	private readonly ecrClientFactory: (credentials: SessionCredentials | null) => EcrPort;
	private readonly customerComputersProvisioner: CustomerComputersProvisioner;

	constructor(options: OrganizationHostStarterOptions) {
		this.getOrganization = options.getOrganization;
		this.environment = options.environment ?? process.env;
		this.deploymentAccountId = options.deploymentAccountId ?? deploymentAwsAccountId(this.environment);
		this.deploymentEcsConfig = options.deploymentEcsConfig ?? null;
		this.assumeRole = options.assumeRole ?? defaultAssumeRole;
		this.ecsClientFactory = options.ecsClientFactory ?? defaultEcsClient;
		this.cloudformationClientFactory = options.cloudformationClientFactory ?? defaultCloudFormationClient;
		this.ecrClientFactory = options.ecrClientFactory ?? defaultEcrClient;
		this.customerComputersProvisioner =
			options.customerComputersProvisioner ??
			new AwsCustomerComputersProvisioner({ templateUrl: customerComputersTemplateUrl(this.environment) });
	}

	/** Run one ECS task in the organization's AWS home account. */
	async startHost(claim: HostStartClaim): Promise<void> {
		const organization = await this.getOrganization(claim.tenantId);
		const homeAccountId = requireAwsHome(organization);
		if (homeAccountId === this.deploymentAccountId) {
			await this.startInDeploymentAccount(claim, homeAccountId);
			return;
		}
		await this.startInCustomerAccount(organization, claim, homeAccountId);
	}

	private async startInDeploymentAccount(claim: HostStartClaim, homeAccountId: string): Promise<void> {
		const config = this.deploymentEcsConfig ?? deploymentEcsConfigFromEnvironment(this.environment);
		if (config === null) {
			this.lastOutcome = { launchAccountId: homeAccountId, refused: false };
			return;
		}
		const ecs = this.ecsClientFactory(null);
		await runFargateTask(ecs, { ...config, claim, environment: this.environment });
		this.lastOutcome = { launchAccountId: homeAccountId, refused: false };
	}

	private async startInCustomerAccount(
		organization: Organization,
		claim: HostStartClaim,
		homeAccountId: string,
	): Promise<void> {
		requireCrossAccountFields(organization);
		let outcome;
		try {
			outcome = await attemptCrossAccountAssumeRole(organization, { assumeRole: this.assumeRole });
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new OrganizationComputerProvisioningError(
				`Organization ${JSON.stringify(organization.tenantId)} computer provisioning failed: cross-account role could not be assumed (${detail}).`,
			);
		}
		if (outcome.refused || outcome.session === null) {
			throw new OrganizationComputerProvisioningError(
				`Organization ${JSON.stringify(organization.tenantId)} computer provisioning failed: cross-account role refused AssumeRole.`,
			);
		}
		const credentials: SessionCredentials = {
			accessKeyId: outcome.session.accessKeyId,
			secretAccessKey: outcome.session.secretAccessKey,
			sessionToken: outcome.session.sessionToken,
		};
		const ecs = this.ecsClientFactory(credentials);
		const cloudformation = this.cloudformationClientFactory(credentials);
		const ecr = this.ecrClientFactory(credentials);
		await this.customerComputersProvisioner.ensureStack(cloudformation, organization);
		const stackResponse = await describeCustomerComputersStack(cloudformation);
		const outputs = stackOutputsFromDescribeStacks(stackResponse);
		const repositoryUri = (outputs[COMPUTER_REPOSITORY_URI_OUTPUT] ?? "").trim();
		if (repositoryUri === "") {
			throw new OrganizationComputerProvisioningError(
				`${COMPUTERS_STACK_NAME} stack outputs are incomplete; ${COMPUTER_REPOSITORY_URI_OUTPUT} is required for host start.`,
			);
		}
		await requireCustomerComputerImage(ecr, { repositoryUri });
		const config = await lookupCustomerComputerEcsConfig(cloudformation);
		await runFargateTask(ecs, { ...config, claim, environment: this.environment });
		this.lastOutcome = { launchAccountId: homeAccountId, refused: false };
	}
}

function customerComputersTemplateUrl(environment: StarterEnvironment): string | null {
	const value = environmentValue(environment, "CHATTICUS_CUSTOMER_COMPUTERS_TEMPLATE_URL");
	return value === "" ? null : value;
}

/** Summon one computer host for one durable host-start claim. */
export interface HostStarter {
	startHost(claim: HostStartClaim): Promise<void>;
}

/** Default starter that records intent only in the control plane. */
export class NoOpHostStarter implements HostStarter {
	/** Do nothing; host boot is exercised elsewhere. */
	async startHost(_claim: HostStartClaim): Promise<void> {}
}

/** What the environment-selected ECS starter may be given in place of the real AWS clients. */
export type EnvironmentHostStarterOptions = Omit<
	OrganizationHostStarterOptions,
	"getOrganization" | "deploymentAccountId" | "deploymentEcsConfig" | "environment"
>;

/** Return the configured host starter for this deployment. */
export function hostStarterFromEnvironment(
	getOrganization: ((tenantId: string) => Promise<Organization>) | null = null,
	environment: StarterEnvironment = process.env,
	options: EnvironmentHostStarterOptions = {},
): HostStarter {
	const kind = (environment.CHATTICUS_HOST_STARTER ?? "noop").trim().toLowerCase();
	if (kind !== "ecs" || getOrganization === null) {
		return new NoOpHostStarter();
	}
	return new OrganizationComputerHostStarter({
		...options,
		getOrganization,
		deploymentAccountId: deploymentAwsAccountId(environment),
		deploymentEcsConfig: deploymentEcsConfigFromEnvironment(environment),
		environment,
	});
}

/** Adapt a host starter to the driver the computer starter calls. */
export function hostStartDriverFor(starter: HostStarter): HostStartDriver {
	return {
		async start(claim: DomainHostStartClaim, job: ComputerStartJob): Promise<void> {
			await starter.startHost({
				tenantId: claim.tenantId,
				computerId: claim.computerId,
				hostStartCount: claim.hostStartGeneration,
				userId: job.userId,
			});
		},
	};
}
